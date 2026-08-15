import { useEffect, useRef, useState } from "react";

export interface SearchResult {
  id: string;
  label: string;
}

export interface DebouncedSearchProps {
  query: (text: string) => Promise<SearchResult[]>;
  debounceMs?: number;
}

type Phase = "idle" | "waiting" | "searching" | "results" | "no-results" | "error";

/**
 * Text input that debounces via setTimeout before firing an async query.
 * Deliberately awkward: correctness depends on timing and quiescence, not
 * just on the final DOM.
 */
export function DebouncedSearch({ query, debounceMs = 300 }: DebouncedSearchProps) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<SearchResult[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function handleChange(value: string) {
    setText(value);
    if (timerRef.current) clearTimeout(timerRef.current);

    if (value.trim().length === 0) {
      setPhase("idle");
      setResults([]);
      return;
    }

    setPhase("waiting");
    timerRef.current = setTimeout(() => {
      const myId = ++requestId.current;
      setPhase("searching");
      query(value)
        .then((res) => {
          if (myId !== requestId.current) return;
          if (res.length === 0) {
            setPhase("no-results");
          } else {
            setResults(res);
            setPhase("results");
          }
        })
        .catch(() => {
          if (myId !== requestId.current) return;
          setPhase("error");
        });
    }, debounceMs);
  }

  return (
    <div>
      <label>
        Search
        <input value={text} onChange={(e) => handleChange(e.target.value)} />
      </label>
      {phase === "idle" && <p>Type to search</p>}
      {phase === "waiting" && <p>...</p>}
      {phase === "searching" && <p role="status">Searching...</p>}
      {phase === "no-results" && <p>No results</p>}
      {phase === "error" && <p role="alert">Search failed</p>}
      {phase === "results" && (
        <ul>
          {results.map((r) => (
            <li key={r.id}>{r.label}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
