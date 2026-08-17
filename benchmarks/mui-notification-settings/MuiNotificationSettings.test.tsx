import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MuiNotificationSettings } from "./MuiNotificationSettings.js";

describe("MuiNotificationSettings", () => {
  it("gates the digest checkbox on the notifications switch and clears it on the way back", async () => {
    const user = userEvent.setup();
    render(<MuiNotificationSettings plan="free" />);

    const notifications = screen.getByRole("switch", { name: "Enable notifications" });
    const digest = screen.getByRole("checkbox", { name: "Weekly digest" });

    expect(notifications).not.toBeChecked();
    expect(digest).toBeDisabled();

    await user.click(notifications);
    expect(digest).toBeEnabled();

    await user.click(digest);
    expect(digest).toBeChecked();

    await user.click(notifications);
    expect(digest).not.toBeChecked();
    expect(digest).toBeDisabled();
  });

  it("renders the SMS checkbox only under plan='pro'", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MuiNotificationSettings plan="free" />);
    expect(screen.queryByRole("checkbox", { name: "SMS alerts" })).toBeNull();

    rerender(<MuiNotificationSettings plan="pro" />);
    const sms = screen.getByRole("checkbox", { name: "SMS alerts" });
    await user.click(sms);
    expect(sms).toBeChecked();
  });

  it("resets everything", async () => {
    const user = userEvent.setup();
    render(<MuiNotificationSettings plan="pro" />);

    await user.click(screen.getByRole("switch", { name: "Enable notifications" }));
    await user.click(screen.getByRole("checkbox", { name: "Weekly digest" }));
    await user.click(screen.getByRole("checkbox", { name: "SMS alerts" }));

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(screen.getByRole("switch", { name: "Enable notifications" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "SMS alerts" })).not.toBeChecked();
  });
});
