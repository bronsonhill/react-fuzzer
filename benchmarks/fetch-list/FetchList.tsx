import { useEffect, useState } from "react";

export interface Item {
  id: string;
  label: string;
}

export interface FetchListProps {
  fetchItems: () => Promise<Item[]>;
}

type Status = "loading" | "error" | "empty" | "loaded";

/**
 * Loads items from `fetchItems` on mount and after Retry. Exercises the
 * loading / error / empty / loaded states from async data fetching.
 */
export function FetchList({ fetchItems }: FetchListProps) {
  const [status, setStatus] = useState<Status>("loading");
  const [items, setItems] = useState<Item[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");

    fetchItems()
      .then((result) => {
        if (cancelled) return;
        if (result.length === 0) {
          setStatus("empty");
        } else {
          setItems(result);
          setStatus("loaded");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [fetchItems, attempt]);

  if (status === "loading") {
    return <p role="status">Loading...</p>;
  }

  if (status === "error") {
    return (
      <div>
        <p role="alert">Failed to load items</p>
        <button type="button" onClick={() => setAttempt((a) => a + 1)}>
          Retry
        </button>
      </div>
    );
  }

  if (status === "empty") {
    return (
      <div>
        <p>No items found</p>
        <button type="button" onClick={() => setAttempt((a) => a + 1)}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>{item.label}</li>
      ))}
    </ul>
  );
}
