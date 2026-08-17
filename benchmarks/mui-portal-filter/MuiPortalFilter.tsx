import { useState } from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Typography from "@mui/material/Typography";

export interface MuiPortalFilterProps {
  /** Whether the "Clear all" action needs confirming before it fires. */
  confirmClear?: boolean;
}

/**
 * A deliberately awkward component: both of its interactive surfaces render
 * through a React portal into document.body. MUI's Select mounts its option
 * list in a Menu portal, and Dialog mounts its whole body there too. Action
 * discovery walks the RTL container, so it sees the Select trigger and the
 * two buttons and nothing else — no options, no dialog buttons.
 *
 * Kept in the corpus as the negative case: the graph it produces is small
 * and correct about what was driven, and wrong about what the component can
 * do. See MuiPortalFilter.expected.ts for the numbers.
 */
export function MuiPortalFilter({ confirmClear = true }: MuiPortalFilterProps) {
  const [status, setStatus] = useState("all");
  const [confirming, setConfirming] = useState(false);

  return (
    <div>
      <InputLabel id="status-label">Status</InputLabel>
      <Select
        labelId="status-label"
        value={status}
        onChange={(e) => setStatus(String(e.target.value))}
      >
        <MenuItem value="all">All</MenuItem>
        <MenuItem value="open">Open</MenuItem>
        <MenuItem value="closed">Closed</MenuItem>
      </Select>

      <Typography>Showing: {status}</Typography>

      <Button
        onClick={() => {
          if (confirmClear) setConfirming(true);
          else setStatus("all");
        }}
      >
        Clear all
      </Button>

      <Dialog open={confirming} onClose={() => setConfirming(false)}>
        <DialogTitle>Clear the filter?</DialogTitle>
        <DialogContent>This resets status to "all".</DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
          <Button
            onClick={() => {
              setStatus("all");
              setConfirming(false);
            }}
          >
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
