"use strict";

function emitSyncProgress(options, event) {
  if (typeof options?.onSyncProgress !== "function") return;
  try {
    options.onSyncProgress(event);
  } catch {
    // Progress telemetry must not change database transaction semantics.
  }
}

module.exports = { emitSyncProgress };
