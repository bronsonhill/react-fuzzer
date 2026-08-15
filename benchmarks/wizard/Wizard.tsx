import { useState } from "react";

export interface WizardProps {
  onComplete?: (data: { name: string; email: string }) => void;
}

/**
 * A three-step wizard. Each step requires its field to be filled before
 * "Next" is enabled. "Back" is always available except on step 1.
 */
export function Wizard({ onComplete }: WizardProps) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);

  if (done) {
    return <p role="status">Wizard complete</p>;
  }

  const canAdvanceFromStep1 = name.trim().length > 0;
  const canAdvanceFromStep2 = email.trim().length > 0;

  return (
    <div>
      <p>Step {step} of 3</p>

      {step === 1 && (
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      )}

      {step === 2 && (
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
      )}

      {step === 3 && <p>Review: {name} / {email}</p>}

      <div>
        {step > 1 && (
          <button type="button" onClick={() => setStep((s) => s - 1)}>
            Back
          </button>
        )}
        {step < 3 && (
          <button
            type="button"
            disabled={step === 1 ? !canAdvanceFromStep1 : !canAdvanceFromStep2}
            onClick={() => setStep((s) => s + 1)}
          >
            Next
          </button>
        )}
        {step === 3 && (
          <button
            type="button"
            onClick={() => {
              setDone(true);
              onComplete?.({ name, email });
            }}
          >
            Finish
          </button>
        )}
      </div>
    </div>
  );
}
