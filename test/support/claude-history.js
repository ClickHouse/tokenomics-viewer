"use strict";

function claudeHistoryRecord({ replay = false, uuid = "shared-message", input = 2 } = {}) {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: "2026-10-10T16:20:03.310Z",
    cwd: "/tmp/claude-history",
    message: {
      id: "shared-api-message",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: replay ? 0 : input,
        cache_creation_input_tokens: replay ? 0 : 2618,
        cache_read_input_tokens: replay ? 0 : 86024,
        output_tokens: replay ? 0 : 12437,
        // Claude history copies zero the totals but can retain these details.
        cache_creation: { ephemeral_5m_input_tokens: 2618, ephemeral_1h_input_tokens: 0 },
        output_tokens_details: { thinking_tokens: 12064 },
        service_tier: "standard",
        speed: "standard",
      },
    },
  });
}

module.exports = { claudeHistoryRecord };
