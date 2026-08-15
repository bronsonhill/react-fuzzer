import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FetchList, type Item } from "./FetchList.js";

describe("FetchList", () => {
  it("drives loading -> error -> loading -> loaded", async () => {
    const user = userEvent.setup();
    const items: Item[] = [{ id: "1", label: "One" }, { id: "2", label: "Two" }];
    let call = 0;
    const fetchItems = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve(items);
    });

    render(<FetchList fetchItems={fetchItems} />);

    // state: loading
    expect(screen.getByRole("status")).toHaveTextContent("Loading...");

    // transition: settle -> error
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to load items"));

    // transition: click Retry -> loading -> (settles fast) -> loaded
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("list")).toBeInTheDocument());
    expect(screen.getByText("One")).toBeInTheDocument();
    expect(screen.getByText("Two")).toBeInTheDocument();
  });

  it("drives loading -> empty -> loading -> loaded", async () => {
    const user = userEvent.setup();
    const items: Item[] = [{ id: "1", label: "One" }];
    let call = 0;
    const fetchItems = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve([]);
      return Promise.resolve(items);
    });

    render(<FetchList fetchItems={fetchItems} />);

    // state: loading
    expect(screen.getByRole("status")).toHaveTextContent("Loading...");

    // transition: settle -> empty
    await waitFor(() => expect(screen.getByText("No items found")).toBeInTheDocument());

    // transition: click Retry -> loading -> (settles fast) -> loaded
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("list")).toBeInTheDocument());
    expect(screen.getByText("One")).toBeInTheDocument();
  });
});
