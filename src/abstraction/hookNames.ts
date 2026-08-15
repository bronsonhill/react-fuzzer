/**
 * Static recovery of declared useState/useReducer variable names via
 * ts-morph, so hook index N can be addressed by a stable name instead of a
 * raw position. This is what lets state identity survive a benign hook
 * reorder or an inserted unrelated hook: the fiber's hook *list* is
 * positional and will visibly change under either edit, but the *name* a
 * developer gave the state does not move.
 *
 * This is a best-effort static approximation. It does not execute the
 * component, so it cannot see hooks called conditionally in a way static
 * analysis can't resolve, hooks whose call is behind a dynamic dispatch, or
 * hooks introduced by a custom hook wrapper (e.g. `useToggle()` that
 * internally calls `useState`). Callers are expected to cross-check the
 * source-derived list against the runtime hook list (see
 * src/abstraction/index.ts) and fall back to index-based naming when they
 * disagree, rather than trust this module blindly.
 */
import { Node, Project, SourceFile, SyntaxKind } from "ts-morph";

export type NamedHookKind = "state" | "reducer";

export interface HookNameEntry {
  name: string;
  kind: NamedHookKind;
}

export interface HookNamingResult {
  /** Declared hook names in source order, state/reducer hooks only. */
  names: HookNameEntry[];
  /** Non-fatal issues encountered; an empty array means clean recovery. */
  warnings: string[];
}

// ts-morph Project construction (TypeChecker setup) is comparatively
// expensive; reuse one Project across calls within a process rather than
// building a fresh one per component.
let sharedProject: Project | undefined;
function getProject(): Project {
  if (!sharedProject) {
    sharedProject = new Project({ skipAddingFilesFromTsConfig: true });
  }
  return sharedProject;
}

function findComponentFunction(sourceFile: SourceFile, componentName: string): Node | undefined {
  const fnDecl = sourceFile.getFunction(componentName);
  if (fnDecl) return fnDecl;

  const varDecl = sourceFile.getVariableDeclaration(componentName);
  if (varDecl) {
    const init = varDecl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init;
    }
  }

  return undefined;
}

/**
 * Recovers the declared names of useState/useReducer hooks for a function
 * component, in source order. Never throws: parse or lookup failures are
 * reported as warnings with an empty `names` array, and the caller decides
 * how to fall back.
 */
export function getHookNames(sourcePath: string, componentName: string): HookNamingResult {
  const warnings: string[] = [];

  let sourceFile: SourceFile;
  try {
    const project = getProject();
    sourceFile = project.getSourceFile(sourcePath) ?? project.addSourceFileAtPath(sourcePath);
  } catch (err) {
    warnings.push(`failed to load source file ${sourcePath}: ${(err as Error).message}`);
    return { names: [], warnings };
  }

  const fn = findComponentFunction(sourceFile, componentName);
  if (!fn) {
    warnings.push(`could not locate function component '${componentName}' in ${sourcePath}`);
    return { names: [], warnings };
  }

  const names: HookNameEntry[] = [];
  let counter = 0;

  fn.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expression = node.getExpression();
    if (!Node.isIdentifier(expression)) return;

    const calleeName = expression.getText();
    if (calleeName !== "useState" && calleeName !== "useReducer") return;

    counter++;
    const kind: NamedHookKind = calleeName === "useState" ? "state" : "reducer";

    const varDecl = node.getParentIfKind(SyntaxKind.VariableDeclaration);
    if (varDecl) {
      const nameNode = varDecl.getNameNode();

      if (Node.isArrayBindingPattern(nameNode)) {
        const elements = nameNode.getElements();
        const first = elements[0];
        if (first && Node.isBindingElement(first)) {
          names.push({ name: first.getName(), kind });
          return;
        }
      }

      if (Node.isIdentifier(nameNode)) {
        // Non-destructured form, e.g. `const s = useState(0)`.
        names.push({ name: nameNode.getText(), kind });
        return;
      }
    }

    const fallback = `hook${counter}`;
    warnings.push(
      `hook #${counter} (${calleeName}) in ${componentName} has no recognisable destructured ` +
        `binding name; falling back to synthesised name '${fallback}'`,
    );
    names.push({ name: fallback, kind });
  });

  return { names, warnings };
}
