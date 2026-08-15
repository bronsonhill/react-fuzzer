import { useState } from "react";

export interface ValidatedFormProps {
  onSubmit?: (data: { email: string; password: string }) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmailValid(value: string): boolean {
  return EMAIL_RE.test(value);
}

function isPasswordValid(value: string): boolean {
  return value.length >= 8;
}

/**
 * Email + password form with per-field validation. Submit is disabled until
 * both fields are valid. Submitting flips to a submitted state.
 */
export function ValidatedForm({ onSubmit }: ValidatedFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return <p role="status">Submitted</p>;
  }

  const emailValid = isEmailValid(email);
  const passwordValid = isPasswordValid(password);
  const canSubmit = emailValid && passwordValid;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) {
          setSubmitted(true);
          onSubmit?.({ email, password });
        }
      }}
    >
      <label>
        Email
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      {email.length > 0 && !emailValid && <span role="alert">Invalid email</span>}

      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {password.length > 0 && !passwordValid && (
        <span role="alert">Password too short</span>
      )}

      <button type="submit" disabled={!canSubmit}>
        Submit
      </button>
    </form>
  );
}
