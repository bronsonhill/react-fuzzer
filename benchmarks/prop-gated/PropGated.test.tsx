import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PropGated } from "./PropGated.js";

describe("PropGated", () => {
  it("drives the simple-mode machine, with the expert button absent", async () => {
    const user = userEvent.setup();
    render(<PropGated mode="simple" />);

    // state: simple_notif-off
    const notif = screen.getByRole("button", { name: /Notifications/ });
    expect(notif).toHaveTextContent("Notifications: Off");
    expect(screen.queryByRole("button", { name: /Expert mode/ })).not.toBeInTheDocument();

    // transition: click Notifications -> simple_notif-on
    await user.click(notif);
    expect(notif).toHaveTextContent("Notifications: On");
    expect(screen.queryByRole("button", { name: /Expert mode/ })).not.toBeInTheDocument();

    // transition: click Notifications -> simple_notif-off
    await user.click(notif);
    expect(notif).toHaveTextContent("Notifications: Off");
  });

  it("drives the full advanced-mode machine, gated states only reachable here", async () => {
    const user = userEvent.setup();
    render(<PropGated mode="advanced" />);

    const notif = screen.getByRole("button", { name: /Notifications/ });
    const expert = screen.getByRole("button", { name: /Expert mode/ });

    // state: advanced_notif-off_expert-off
    expect(notif).toHaveTextContent("Notifications: Off");
    expect(expert).toHaveTextContent("Expert mode: Off");

    // transition: click Notifications -> advanced_notif-on_expert-off
    await user.click(notif);
    expect(notif).toHaveTextContent("Notifications: On");
    expect(expert).toHaveTextContent("Expert mode: Off");

    // transition: click Expert mode -> advanced_notif-on_expert-on
    await user.click(expert);
    expect(notif).toHaveTextContent("Notifications: On");
    expect(expert).toHaveTextContent("Expert mode: On");

    // transition: click Notifications -> advanced_notif-off_expert-on
    await user.click(notif);
    expect(notif).toHaveTextContent("Notifications: Off");
    expect(expert).toHaveTextContent("Expert mode: On");

    // transition: click Expert mode -> advanced_notif-off_expert-off
    await user.click(expert);
    expect(notif).toHaveTextContent("Notifications: Off");
    expect(expert).toHaveTextContent("Expert mode: Off");
  });
});
