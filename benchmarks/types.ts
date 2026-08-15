export interface ExpectedState {
  id: string;
  description: string;
}

export interface ExpectedTransition {
  from: string;
  action: string;
  to: string;
  note?: string;
}

export interface ExpectedMachine {
  component: string;
  defaultProps: Record<string, unknown> | string; // describe non-serialisable props in prose
  states: ExpectedState[];
  transitions: ExpectedTransition[];
  notes?: string[]; // anything ambiguous, e.g. states you are unsure should count as distinct
}
