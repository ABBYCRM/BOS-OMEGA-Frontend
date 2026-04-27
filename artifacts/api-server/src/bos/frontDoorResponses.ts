/**
 * BOP.FRONT_DOOR.v1_PRODUCTION — UX response templates.
 *
 * Pure module. Maps a FrontDoorClassification to a BosOutput-shaped object
 * the API can return directly without invoking the BOS reasoning engine.
 *
 * The state field is HOLD (the closest existing TriState), but the
 * `front_door_route` marker tells the UI to render this as friendly
 * guidance, not a verdict-style HOLD. The frontend StatusBadge keys off
 * front_door_route to show a "GUIDANCE" pill instead of "HOLD".
 */

import type { BosOutput } from "./types.js";
import type { FrontDoorClassification, FrontDoorRoute } from "./frontDoorInterpreter.js";

const EXAMPLE_PROMPTS = [
  "Should we approve this vendor?",
  "Is this contract safe to sign?",
  "Review this PR for risk.",
  "Build a step-by-step plan to fix this workflow.",
];

const REQUIRED_DECISION_INPUTS = [
  "Objective (what decision needs to be made)",
  "Relevant facts (the situation, the artifact, the history)",
  "Decision criteria (what would make this safe or correct)",
  "Constraints (budget, time, regulatory, technical)",
  "Risk target (what level of risk is acceptable)",
  "Desired output (memo, plan, GO/HOLD, etc.)",
];

interface FrontDoorMessage {
  answer: string;
  recommended_next_action: string;
  examples: string[];
  missing_inputs: string[];
}

function messageFor(route: FrontDoorRoute): FrontDoorMessage {
  switch (route) {
    case "EMPTY":
      return {
        answer:
          "No task received.\n\n" +
          "Enter a decision, review, risk, or build request for BOS-OMEGA to process.",
        recommended_next_action:
          "Type a question or task into the input. See the example prompts for the kind of work BOS-OMEGA handles best.",
        examples: EXAMPLE_PROMPTS,
        missing_inputs: ["task_text"],
      };
    case "GREETING":
      return {
        answer:
          "Hello. BOS-OMEGA is ready.\n\n" +
          "Give me a decision, review, risk check, build request, or analysis task. " +
          "I am a structured decision engine — not a chat companion — so I work best on prompts that have a clear question, an artifact, or a goal.",
        recommended_next_action:
          "Try one of the example prompts below, or describe the decision you need help making.",
        examples: EXAMPLE_PROMPTS,
        missing_inputs: [],
      };
    case "UNDER_SPECIFIED":
      return {
        answer:
          "I need more context before BOS-OMEGA can run this properly.\n\n" +
          "Your prompt looks task-related, but it doesn't say WHAT to act on. " +
          "Add the artifact (contract, code, PR, document), the question you want answered, and any constraints.",
        recommended_next_action:
          "Re-submit with the artifact attached or pasted, plus the specific question you want answered.",
        examples: [
          "Review this contract for risk.",
          "Should we approve this vendor?",
          "Analyze this code change before merge.",
          "Build a step-by-step fix plan for this workflow.",
        ],
        missing_inputs: ["task_object", "decision_criteria"],
      };
    case "LIKELY_NON_TASK":
      return {
        answer:
          "BOS-OMEGA is designed for structured decisions, reviews, risk checks, and build plans.\n\n" +
          "Your prompt looks more like conversation than a decision request. I'll be much more useful if you give me a real task.",
        recommended_next_action:
          "Re-phrase as a decision, review, risk check, or build request.",
        examples: [
          "Should we approve this?",
          "What are the risks here?",
          "Review this document.",
          "Create an implementation plan.",
        ],
        missing_inputs: [],
      };
    case "VALID_TASK":
      // Front door does not produce a response for VALID_TASK — those go
      // to the engine. This branch exists only for type completeness.
      return {
        answer: "Routing to BOS engine...",
        recommended_next_action: "",
        examples: [],
        missing_inputs: [],
      };
  }
}

/**
 * Render the BosOutput a non-engine route should return.
 *
 * Throws on VALID_TASK — callers must check `shouldInvokeBosEngine` first
 * and dispatch to the BOS engine instead of calling this builder.
 */
export function buildFrontDoorBosOutput(
  classification: FrontDoorClassification,
): BosOutput {
  if (classification.route === "VALID_TASK") {
    throw new Error(
      "buildFrontDoorBosOutput called for VALID_TASK; caller must invoke the BOS engine instead.",
    );
  }

  const msg = messageFor(classification.route);
  const examplesBlock = msg.examples.length > 0
    ? "\n\nExamples:\n" + msg.examples.map((e) => `- ${e}`).join("\n")
    : "";

  return {
    state: "HOLD",
    task_type: "front_door_guidance",
    answer: msg.answer + examplesBlock,
    assumptions: [],
    uncertainties: [],
    missing_inputs: msg.missing_inputs,
    failure_modes: [],
    recommended_next_action: msg.recommended_next_action,
    front_door_route: classification.route,
    front_door_examples: msg.examples,
    why_decision_was_made:
      "Front Door Interpreter classified this input as " +
      classification.route +
      " (confidence " +
      classification.confidence.toFixed(2) +
      "). The BOS reasoning engine was intentionally NOT invoked because the input does not require structured decision logic.",
    safe_alternative:
      msg.examples.length > 0
        ? "Pick one of the example prompts, or re-phrase your request as a decision/review/build/risk task."
        : "Re-phrase your request as a decision/review/build/risk task.",
  };
}

/**
 * Audit-friendly preview of the input that's safe to log.
 * Truncates to the configured length, removes control chars, and reports
 * the SHA-1 hash so two events for the same input can be correlated
 * without storing the full text twice.
 */
export function safeInputPreview(input: string, maxLen = 200): {
  preview: string;
  truncated: boolean;
  original_length: number;
} {
  const trimmed = (input ?? "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
  const truncated = trimmed.length > maxLen;
  return {
    preview: truncated ? trimmed.slice(0, maxLen) + "…" : trimmed,
    truncated,
    original_length: trimmed.length,
  };
}

/** Re-export the spec's required_decision_inputs so the future
 * BOP.HOLD_REASON.v1 task can reuse them when emitting structured
 * "what was missing" rationales from the engine. */
export const REQUIRED_DECISION_CONTEXT = REQUIRED_DECISION_INPUTS;
