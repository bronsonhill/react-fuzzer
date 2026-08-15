import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

function Hello({ name }: { name: string }) {
  return <p>Hello, {name}!</p>;
}

describe("test harness smoke test", () => {
  it("renders a trivial component and finds it via Testing Library", () => {
    render(<Hello name="world" />);
    expect(screen.getByText("Hello, world!")).toBeInTheDocument();
  });
});
