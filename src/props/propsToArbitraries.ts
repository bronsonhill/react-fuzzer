/**
 * M4 Deliverable A: props to arbitraries. Extracts a component's props
 * interface with ts-morph (the TS compiler API, per docs/poc-plan.md's
 * stated preference over react-docgen-typescript, which "does not reliably
 * resolve imported or externally declared types") and maps each declared
 * prop type to a fast-check arbitrary.
 *
 * What is inferred automatically:
 *   - string / number / boolean primitives, bounded to modest ranges so
 *     generated values stay legible in a report.
 *   - string-literal and numeric-literal unions -> fc.constantFrom(...
 *     members). This is the highest-value case: PropGated's
 *     `mode: 'simple' | 'advanced'` is exactly this shape.
 *   - optional props ("prop?: T") -> fc.option, so omission is itself a
 *     generated possibility.
 *   - arrays of an inferrable element type, and plain object/interface
 *     types whose own properties are all inferrable, recursively, bounded
 *     in size (see ARRAY_MAX_LENGTH).
 *
 * What is NOT guessed, ever: function types (including ReactNode's function
 * component union member and any callback prop) and any type this module
 * fails to resolve to one of the above shapes. `mapPropType` throws a clear
 * error naming the offending prop instead of silently generating a no-op
 * stand-in -- a silently-generated no-op callback would produce a graph
 * that quietly misses every transition gated behind that callback actually
 * being invoked meaningfully, which is worse than failing loudly. The
 * escape hatch is `propOverrides`: a caller-supplied
 * `Record<string, fc.Arbitrary<unknown>>` that is consulted before any
 * inference is attempted, so an override always wins outright and never
 * needs to satisfy the inference rules above.
 */
import fc from "fast-check";
import { Node, Project, SourceFile, InterfaceDeclaration, TypeAliasDeclaration, Type } from "ts-morph";

export interface PropsToArbitrariesOptions {
  /** Path to the component's source file. */
  sourcePath: string;
  /** Component function name, used to locate `${componentName}Props` (or the function's parameter type) and as the fallback interface name. */
  componentName: string;
  /**
   * Developer-supplied arbitraries, keyed by prop name. Consulted before any
   * inference is attempted for that prop, so it always wins and can cover
   * anything -- function props, ReactNode, a union with domain meaning that
   * inference would otherwise misclassify as a plain string, etc.
   */
  propOverrides?: Record<string, fc.Arbitrary<unknown>>;
}

export interface PropsToArbitrariesResult {
  /** One arbitrary per declared prop, ready to pass to fc.record(). */
  arbitraries: Record<string, fc.Arbitrary<unknown>>;
  /** Prop names resolved by inference (not by an override), for reporting. */
  inferred: string[];
  /** Prop names resolved via propOverrides, for reporting. */
  overridden: string[];
}

const STRING_MAX_LENGTH = 12;
const NUMBER_MIN = -100;
const NUMBER_MAX = 100;
const ARRAY_MAX_LENGTH = 3;
const MAX_RECURSION_DEPTH = 4;

let sharedProject: Project | undefined;
function getProject(): Project {
  if (!sharedProject) {
    sharedProject = new Project({ skipAddingFilesFromTsConfig: true });
  }
  return sharedProject;
}

function findPropsInterface(
  sourceFile: SourceFile,
  componentName: string,
): InterfaceDeclaration | TypeAliasDeclaration | undefined {
  const byConvention = sourceFile.getInterface(`${componentName}Props`);
  if (byConvention) return byConvention;
  const aliasByConvention = sourceFile.getTypeAlias(`${componentName}Props`);
  if (aliasByConvention) return aliasByConvention;

  // Fall back to the function component's declared parameter type.
  const fnDecl = sourceFile.getFunction(componentName);
  const paramTypeNode = fnDecl?.getParameters()[0]?.getTypeNode();
  if (paramTypeNode && Node.isTypeReference(paramTypeNode)) {
    const name = paramTypeNode.getTypeName().getText();
    return sourceFile.getInterface(name) ?? sourceFile.getTypeAlias(name);
  }

  return undefined;
}

class UnresolvedPropError extends Error {
  constructor(propPath: string, reason: string) {
    super(
      `propsToArbitraries: cannot infer an arbitrary for prop "${propPath}" (${reason}). ` +
        `Supply an explicit arbitrary for it via propOverrides.`,
    );
    this.name = "UnresolvedPropError";
  }
}

/** True if every member of a union type is a string-literal type. */
function isStringLiteralUnion(type: Type): boolean {
  return type.isUnion() && type.getUnionTypes().every((t) => t.isStringLiteral());
}

function isNumberLiteralUnion(type: Type): boolean {
  return type.isUnion() && type.getUnionTypes().every((t) => t.isNumberLiteral());
}

/**
 * Maps one ts-morph Type to a fast-check arbitrary. `propPath` is a
 * dotted/bracketed path used only for error messages (e.g. "items[].label").
 * Throws UnresolvedPropError for anything not explicitly handled -- see this
 * module's doc comment for why that is deliberate.
 */
function mapType(type: Type, propPath: string, depth: number): fc.Arbitrary<unknown> {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new UnresolvedPropError(propPath, "exceeded max recursion depth for a nested object/array type");
  }

  // Literal unions first (most specific, and the highest-value case per the
  // deliverable): a string- or number-literal union is exactly a small
  // enum-shaped domain, e.g. PropGated's `mode: 'simple' | 'advanced'`.
  if (isStringLiteralUnion(type)) {
    const members = type.getUnionTypes().map((t) => t.getLiteralValueOrThrow() as string);
    return fc.constantFrom(...members);
  }
  if (isNumberLiteralUnion(type)) {
    const members = type.getUnionTypes().map((t) => Number(t.getLiteralValueOrThrow()));
    return fc.constantFrom(...members);
  }

  // `T | undefined` (an optional prop's declared type, or an explicit
  // `T | undefined` union): map the non-undefined member(s) and wrap in
  // fc.option so omission (undefined) is itself a generated possibility.
  if (type.isUnion() && type.getUnionTypes().some((t) => t.isUndefined())) {
    const rest = type.getUnionTypes().filter((t) => !t.isUndefined());
    if (rest.length === 1) {
      const inner = mapType(rest[0]!, propPath, depth + 1);
      return fc.option(inner, { nil: undefined });
    }
    throw new UnresolvedPropError(propPath, `unsupported union shape: ${type.getText()}`);
  }

  if (type.isBoolean() || type.isBooleanLiteral()) return fc.boolean();

  if (type.isString()) return fc.string({ maxLength: STRING_MAX_LENGTH });

  if (type.isNumber()) return fc.integer({ min: NUMBER_MIN, max: NUMBER_MAX });

  if (type.isArray()) {
    const elementType = type.getArrayElementTypeOrThrow();
    const elementArb = mapType(elementType, `${propPath}[]`, depth + 1);
    return fc.array(elementArb, { maxLength: ARRAY_MAX_LENGTH });
  }

  // Function types (callbacks, data sources like FetchList's `fetchItems`)
  // are never guessed at -- see this module's doc comment.
  if (type.getCallSignatures().length > 0) {
    throw new UnresolvedPropError(propPath, "function-typed prop; requires an explicit override");
  }

  // A plain object/interface type whose properties are all themselves
  // inferrable: recurse into an fc.record. This deliberately excludes
  // anything with call signatures (already handled above) and anything
  // ts-morph reports as `any`/`unknown` (e.g. an unresolved externally
  // declared type, or ReactNode's structurally-untyped members), which are
  // rejected below rather than guessed at.
  if (type.isObject() && !type.isArray()) {
    const properties = type.getProperties();
    if (properties.length === 0) {
      throw new UnresolvedPropError(propPath, `unresolved or empty object type: ${type.getText()}`);
    }
    const fields: Record<string, fc.Arbitrary<unknown>> = {};
    for (const prop of properties) {
      const decls = prop.getDeclarations();
      const propType = decls[0] ? prop.getTypeAtLocation(decls[0]) : undefined;
      if (!propType) {
        throw new UnresolvedPropError(`${propPath}.${prop.getName()}`, "could not resolve property type");
      }
      const optional = prop.isOptional();
      const fieldArb = mapType(propType, `${propPath}.${prop.getName()}`, depth + 1);
      fields[prop.getName()] = optional ? fc.option(fieldArb, { nil: undefined }) : fieldArb;
    }
    return fc.record(fields);
  }

  throw new UnresolvedPropError(propPath, `unsupported/unresolved type: ${type.getText()}`);
}

/**
 * Extracts `${componentName}Props` from `sourcePath` and maps each prop to a
 * fast-check arbitrary. Props present in `propOverrides` use the supplied
 * arbitrary directly, bypassing inference entirely. Any other prop that
 * inference cannot resolve throws, naming the prop -- see this module's doc
 * comment.
 */
export function propsToArbitraries(options: PropsToArbitrariesOptions): PropsToArbitrariesResult {
  const project = getProject();
  const sourceFile =
    project.getSourceFile(options.sourcePath) ?? project.addSourceFileAtPath(options.sourcePath);

  const decl = findPropsInterface(sourceFile, options.componentName);
  if (!decl) {
    throw new Error(
      `propsToArbitraries: could not locate a props interface/type for component "${options.componentName}" in ${options.sourcePath}`,
    );
  }

  const type = decl.getType();
  const properties = type.getProperties();

  const arbitraries: Record<string, fc.Arbitrary<unknown>> = {};
  const inferred: string[] = [];
  const overridden: string[] = [];
  const overrides = options.propOverrides ?? {};

  for (const prop of properties) {
    const name = prop.getName();
    if (name in overrides) {
      arbitraries[name] = overrides[name]!;
      overridden.push(name);
      continue;
    }
    const decls = prop.getDeclarations();
    const propType = decls[0] ? prop.getTypeAtLocation(decls[0]) : undefined;
    if (!propType) {
      throw new UnresolvedPropError(name, "could not resolve property type");
    }
    const optional = prop.isOptional();
    const arb = mapType(propType, name, 0);
    arbitraries[name] = optional ? fc.option(arb, { nil: undefined }) : arb;
    inferred.push(name);
  }

  return { arbitraries, inferred, overridden };
}
