import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ValidatedForm } from "./ValidatedForm.js";

describe("ValidatedForm", () => {
  it("drives a representative path through every state", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ValidatedForm onSubmit={onSubmit} />);

    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    const submit = screen.getByRole("button", { name: "Submit" });

    // state: email-empty_pw-empty
    expect(submit).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // -> email-invalid_pw-empty
    await user.type(email, "not-an-email");
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid email");
    expect(submit).toBeDisabled();

    // -> email-invalid_pw-invalid
    await user.type(password, "short");
    expect(submit).toBeDisabled();

    // -> email-valid_pw-invalid (fix email)
    await user.clear(email);
    await user.type(email, "ada@example.com");
    expect(screen.queryByText("Invalid email")).not.toBeInTheDocument();
    expect(screen.getByText("Password too short")).toBeInTheDocument();
    expect(submit).toBeDisabled();

    // -> email-valid_pw-valid
    await user.type(password, "1234"); // "short1234" >= 8 chars
    expect(screen.queryByText("Password too short")).not.toBeInTheDocument();
    expect(submit).not.toBeDisabled();

    // -> email-empty_pw-valid (clear email)
    await user.clear(email);
    expect(submit).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // -> email-valid_pw-valid again
    await user.type(email, "ada@example.com");
    expect(submit).not.toBeDisabled();

    // -> email-valid_pw-empty (clear password)
    await user.clear(password);
    expect(submit).toBeDisabled();

    // -> email-empty_pw-empty
    await user.clear(email);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // -> email-empty_pw-invalid
    await user.type(password, "short");
    expect(submit).toBeDisabled();

    // -> email-empty_pw-valid
    await user.type(password, "1234");
    expect(submit).toBeDisabled();

    // rebuild to valid/valid and submit -> submitted
    await user.type(email, "ada@example.com");
    expect(submit).not.toBeDisabled();
    await user.click(submit);

    expect(screen.getByRole("status")).toHaveTextContent("Submitted");
    expect(onSubmit).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "short1234",
    });
  });
});
