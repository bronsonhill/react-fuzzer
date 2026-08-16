import fc from "fast-check";
import type { Item } from "../../benchmarks/fetch-list/FetchList.js";

type Outcome = "populated" | "empty" | "reject";
const items: Item[] = [{ id: "1", label: "One" }];

function makeFetchItems(outcome: Outcome): () => Promise<Item[]> {
  if (outcome === "reject") return () => Promise.reject(new Error("boom"));
  if (outcome === "empty") return () => Promise.resolve([]);
  return () => Promise.resolve(items);
}

export default {
  exampleProps: { fetchItems: makeFetchItems("reject") },
  propOverrides: {
    fetchItems: fc.constantFrom<Outcome>("populated", "empty", "reject").map((outcome) => makeFetchItems(outcome)),
  },
  settle: { useFakeTimers: false, maxIterations: 20, maxTimeBudgetMs: 2000 },
  invokableProps: {},
};
