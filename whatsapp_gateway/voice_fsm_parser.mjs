/**
 * Ambient Voice-to-FSM Audio & Natural Language Intent Parser
 * Enables deskless floor staff, cooks, and couriers to speak voice notes
 * (transcribed via Whisper or local audio bridge) in English or Swahili/Sheng,
 * extracting monotonic FSM station commands with high precision.
 */

export const INTENT_MAPPINGS = [
  {
    command: "!paid",
    patterns: [
      /(?:paid|lipa|nimepokea\s+pesa|malipo|payment|clear)\b.*?(?:order\s+)?([#0-9a-fA-Z-]+).*?(?:ref|code|mpesa)?\s+([A-Z0-9]{8,12})/i,
      /(?:order\s+)?([#0-9a-fA-Z-]+).*?(?:paid|lipa|malipo).*?([A-Z0-9]{8,12})/i
    ]
  },
  {
    command: "!pack",
    patterns: [
      /(?:pack|packaging|nimepack|funga|weka\s+kwa\s+box|boxed)\b.*?(?:order\s+)?([#0-9a-fA-Z-]+)/i,
      /(?:order\s+)?([#0-9a-fA-Z-]+).*?(?:pack|nimepack|boxed|tayari\s+kwa\s+box)/i
    ]
  },
  {
    command: "!verify",
    patterns: [
      /(?:verify|check|hakiki|qa|inspected|approved)\b.*?(?:order\s+)?([#0-9a-fA-Z-]+)/i,
      /(?:order\s+)?([#0-9a-fA-Z-]+).*?(?:verify|hakiki|qa\s+pass)/i
    ]
  },
  {
    command: "!dispatch",
    patterns: [
      /(?:dispatch|ondoka|deliver|kabidhi|in\s+transit|beba)\b.*?(?:order\s+)?([#0-9a-fA-Z-]+)(?:\s+(?:na|with|rider|courier)\s+([A-Za-z]+))?/i,
      /(?:order\s+)?([#0-9a-fA-Z-]+).*?(?:dispatch|ondoka|peana\s+kwa\s+rider)(?:\s+([A-Za-z]+))?/i
    ]
  },
  {
    command: "!delivered",
    patterns: [
      /(?:delivered|imefika|mteja\s+amepata|imeshafika)\b.*?(?:order\s+)?([#0-9a-fA-Z-]+)/i
    ]
  },
  {
    command: "!status",
    patterns: [
      /(?:status|vitals|hali|orders\s+ngapi|open\s+orders)\b/i
    ]
  }
];

/**
 * Parses transcribed audio speech or natural language text into a structured FSM command.
 */
export function parseVoiceTranscription(transcript) {
  if (!transcript || typeof transcript !== "string") {
    return { success: false, reason: "EMPTY_TRANSCRIPTION" };
  }

  const clean = transcript.trim();

  for (const mapping of INTENT_MAPPINGS) {
    for (const pattern of mapping.patterns) {
      const match = clean.match(pattern);
      if (match) {
        let orderId = match[1] ? match[1].replace(/^#/, "") : null;
        let extraArg = match[2] || null;

        // Construct normalized command
        let normalizedCommand = mapping.command;
        if (orderId && extraArg) {
          normalizedCommand += ` ${orderId} ${extraArg}`;
        } else if (orderId) {
          normalizedCommand += ` ${orderId}`;
        }

        return {
          success: true,
          command: mapping.command,
          orderId,
          extraArg,
          normalizedCommand,
          rawTranscript: clean,
          confidence: 0.95
        };
      }
    }
  }

  return {
    success: false,
    reason: "NO_MATCHING_FSM_INTENT",
    rawTranscript: clean
  };
}
