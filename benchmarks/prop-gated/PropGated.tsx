import { useState } from "react";

export interface PropGatedProps {
  mode: "simple" | "advanced";
}

/**
 * A settings-style panel whose `mode` prop gates an entire branch of
 * internal state. In 'simple' mode only a single visible toggle exists.
 * In 'advanced' mode an extra internal toggle becomes reachable that is
 * completely unreachable when mode is 'simple'. This is the M4 target:
 * the gated states should only appear with 'generated-props' provenance
 * unless 'advanced' is also the example/default prop assignment.
 */
export function PropGated({ mode }: PropGatedProps) {
  const [notificationsOn, setNotificationsOn] = useState(false);
  const [expertModeOn, setExpertModeOn] = useState(false);

  return (
    <div>
      <button
        type="button"
        aria-pressed={notificationsOn}
        onClick={() => setNotificationsOn((v) => !v)}
      >
        Notifications: {notificationsOn ? "On" : "Off"}
      </button>

      {mode === "advanced" && (
        <button
          type="button"
          aria-pressed={expertModeOn}
          onClick={() => setExpertModeOn((v) => !v)}
        >
          Expert mode: {expertModeOn ? "On" : "Off"}
        </button>
      )}
    </div>
  );
}
