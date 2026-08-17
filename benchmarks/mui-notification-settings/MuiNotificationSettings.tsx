import { useState } from "react";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";

export interface MuiNotificationSettingsProps {
  plan: "free" | "pro";
}

/**
 * The same shape as the PropGated benchmark, built out of Material UI
 * components instead of bare DOM elements. Everything here renders inline
 * (Switch and Checkbox each render a real `input[type=checkbox]` inside
 * their label), so action discovery sees it without any portal handling —
 * which is the point of pairing this with MuiPortalFilter, where it does
 * not.
 *
 * `plan` gates the SMS checkbox, so smsAlerts is only ever reachable under
 * plan='pro'. `digest` is disabled while notifications are off, which is
 * what puts entries in the engine's `unavailable` list rather than in the
 * graph.
 */
export function MuiNotificationSettings({ plan }: MuiNotificationSettingsProps) {
  const [enabled, setEnabled] = useState(false);
  const [digest, setDigest] = useState(false);
  const [smsAlerts, setSmsAlerts] = useState(false);

  return (
    <Stack>
      <FormControlLabel
        control={
          <Switch
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              if (!e.target.checked) setDigest(false);
            }}
          />
        }
        label="Enable notifications"
      />

      <FormControlLabel
        control={
          <Checkbox
            checked={digest}
            disabled={!enabled}
            onChange={(e) => setDigest(e.target.checked)}
          />
        }
        label="Weekly digest"
      />

      {plan === "pro" && (
        <FormControlLabel
          control={<Checkbox checked={smsAlerts} onChange={(e) => setSmsAlerts(e.target.checked)} />}
          label="SMS alerts"
        />
      )}

      <Button
        onClick={() => {
          setEnabled(false);
          setDigest(false);
          setSmsAlerts(false);
        }}
      >
        Reset
      </Button>
    </Stack>
  );
}
