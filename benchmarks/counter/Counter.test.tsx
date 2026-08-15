import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Counter } from "./Counter.js";

describe("Counter", () => {
  it("drives min -> mid -> max -> mid -> min and checks disabled bounds", async () => {
    const user = userEvent.setup();
    render(<Counter />);

    const count = screen.getByLabelText("count");
    const dec = screen.getByRole("button", { name: "decrement" });
    const inc = screen.getByRole("button", { name: "increment" });

    // state: min (0)
    expect(count).toHaveTextContent("0");
    expect(dec).toBeDisabled();
    expect(inc).not.toBeDisabled();

    // transition: increment -> mid (1)
    await user.click(inc);
    expect(count).toHaveTextContent("1");
    expect(dec).not.toBeDisabled();
    expect(inc).not.toBeDisabled();

    // mid self-loop transitions: 1 -> 2 -> 3 -> 4
    await user.click(inc);
    await user.click(inc);
    await user.click(inc);
    expect(count).toHaveTextContent("4");
    expect(dec).not.toBeDisabled();
    expect(inc).not.toBeDisabled();

    // transition: mid -> max (5)
    await user.click(inc);
    expect(count).toHaveTextContent("5");
    expect(inc).toBeDisabled();
    expect(dec).not.toBeDisabled();

    // transition: max -> mid (4)
    await user.click(dec);
    expect(count).toHaveTextContent("4");
    expect(inc).not.toBeDisabled();
    expect(dec).not.toBeDisabled();

    // drive back down to min
    await user.click(dec);
    await user.click(dec);
    await user.click(dec);
    expect(count).toHaveTextContent("1");

    // transition: mid -> min (0)
    await user.click(dec);
    expect(count).toHaveTextContent("0");
    expect(dec).toBeDisabled();
    expect(inc).not.toBeDisabled();
  });
});
