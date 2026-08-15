import type { CommitSnapshot, ComponentSnapshot } from "../../src/fiber/index.js";

export function findComponentSnapshot(snapshot: CommitSnapshot, name: string): ComponentSnapshot {
  const found = snapshot.components.find((c) => c.componentName === name);
  if (!found) {
    throw new Error(
      `component ${name} not found in snapshot; found: ${snapshot.components.map((c) => c.componentName).join(",")}`,
    );
  }
  return found;
}
