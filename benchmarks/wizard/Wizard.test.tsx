import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Wizard } from "./Wizard.js";

describe("Wizard", () => {
  it("drives every transition in the expected machine", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Wizard onComplete={onComplete} />);

    // state: step1-empty
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    let nameInput = screen.getByLabelText("Name");
    let nextButton = screen.getByRole("button", { name: "Next" });
    expect(nextButton).toBeDisabled();

    // transition: type into name -> step1-filled
    await user.type(nameInput, "Ada");
    expect(nextButton).not.toBeDisabled();

    // transition: clear name -> step1-empty
    await user.clear(nameInput);
    expect(nextButton).toBeDisabled();

    // transition: type into name -> step1-filled
    await user.type(nameInput, "Ada");
    expect(nextButton).not.toBeDisabled();

    // transition: click Next -> step2-empty
    await user.click(nextButton);
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    let emailInput = screen.getByLabelText("Email");
    nextButton = screen.getByRole("button", { name: "Next" });
    expect(nextButton).toBeDisabled();

    // transition: click Back -> step1-filled
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    nameInput = screen.getByLabelText("Name");
    expect(nameInput).toHaveValue("Ada");
    nextButton = screen.getByRole("button", { name: "Next" });
    expect(nextButton).not.toBeDisabled();

    // transition: click Next -> step2-empty (again)
    await user.click(nextButton);
    emailInput = screen.getByLabelText("Email");
    nextButton = screen.getByRole("button", { name: "Next" });
    expect(nextButton).toBeDisabled();

    // transition: type into email -> step2-filled
    await user.type(emailInput, "ada@example.com");
    expect(nextButton).not.toBeDisabled();

    // transition: clear email -> step2-empty
    await user.clear(emailInput);
    expect(nextButton).toBeDisabled();

    // transition: type into email -> step2-filled
    await user.type(emailInput, "ada@example.com");
    expect(nextButton).not.toBeDisabled();

    // transition: click Next -> step3
    await user.click(nextButton);
    expect(screen.getByText("Review: Ada / ada@example.com")).toBeInTheDocument();

    // transition: click Back -> step2-filled
    await user.click(screen.getByRole("button", { name: "Back" }));
    emailInput = screen.getByLabelText("Email");
    expect(emailInput).toHaveValue("ada@example.com");

    // transition: click Next -> step3 (again)
    await user.click(screen.getByRole("button", { name: "Next" }));

    // transition: click Finish -> done
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(screen.getByRole("status")).toHaveTextContent("Wizard complete");
    expect(onComplete).toHaveBeenCalledWith({ name: "Ada", email: "ada@example.com" });
  });
});
