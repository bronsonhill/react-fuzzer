import fc from "fast-check";
import type { SearchResult } from "../../benchmarks/debounced-search/DebouncedSearch.js";

const results: SearchResult[] = [{ id: "1", label: "Result A" }];
const query = (text: string): Promise<SearchResult[]> => {
  if (text.includes("errorterm")) return Promise.reject(new Error("boom"));
  if (text.includes("emptyterm")) return Promise.resolve([]);
  return Promise.resolve(results);
};

export default {
  exampleProps: { query, debounceMs: 300 },
  propOverrides: { query: fc.constant(query) },
  fillPools: () => ["", "resultsterm", "emptyterm", "errorterm"],
  settle: { useFakeTimers: true, timerStepMs: 50, maxIterations: 20, maxTimeBudgetMs: 2000 },
  invokableProps: {},
  useFakeTimers: true,
};
