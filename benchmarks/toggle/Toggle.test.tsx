import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toggle } from "./Toggle.js";

describe("Toggle", () => {
  it("drives the off -> on -> off machine", async () => {
    const user = userEvent.setup();
    render(<Toggle />);

    const button = screen.getByRole("button");
    // state: off
    expect(button).toHaveTextContent("Off");
    expect(button).toHaveAttribute("aria-pressed", "false");

    // transition: click -> on
    await user.click(button);
    expect(button).toHaveTextContent("On");
    expect(button).toHaveAttribute("aria-pressed", "true");

    // transition: click -> off
    await user.click(button);
    expect(button).toHaveTextContent("Off");
    expect(button).toHaveAttribute("aria-pressed", "false");
  });
});
