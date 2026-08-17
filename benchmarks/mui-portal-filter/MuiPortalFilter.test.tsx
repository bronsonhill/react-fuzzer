import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MuiPortalFilter } from "./MuiPortalFilter.js";

/**
 * The hand-written counterpart to the tool's own exploration of this
 * component: everything here goes through screen (document-wide) rather
 * than a container, which is exactly the difference that lets these tests
 * reach the portalled Menu and Dialog that action discovery cannot.
 */
describe("MuiPortalFilter", () => {
  it("changes status through the portalled Select menu", async () => {
    const user = userEvent.setup();
    render(<MuiPortalFilter />);

    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(within(screen.getByRole("listbox")).getByText("Open"));

    expect(screen.getByText("Showing: open")).toBeInTheDocument();
  });

  it("confirms before clearing, and cancels without clearing", async () => {
    const user = userEvent.setup();
    render(<MuiPortalFilter />);

    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(within(screen.getByRole("listbox")).getByText("Closed"));
    await user.click(screen.getByRole("button", { name: "Clear all" }));

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Showing: closed")).toBeInTheDocument();

    // The dialog's close is animated; until it unmounts, MUI keeps the rest
    // of the page inert, so "Clear all" is not clickable yet.
    await user.click(await screen.findByRole("button", { name: "Clear all" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
    expect(screen.getByText("Showing: all")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears immediately when confirmClear is false", async () => {
    const user = userEvent.setup();
    render(<MuiPortalFilter confirmClear={false} />);

    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(within(screen.getByRole("listbox")).getByText("Open"));
    await user.click(screen.getByRole("button", { name: "Clear all" }));

    expect(screen.getByText("Showing: all")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
