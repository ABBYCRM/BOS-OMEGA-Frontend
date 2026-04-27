/**
 * BOP.FRONT_DOOR.v1_PRODUCTION — Front Door Interpreter
 *
 * Pure, deterministic, no-deps classifier that runs BEFORE the BOS Tri-State
 * reasoning engine. Decides whether incoming user input deserves to enter
 * the engine at all, or whether it should be routed to a friendlier UX
 * response (greeting, empty, under-specified, likely-non-task).
 *
 * Architectural principle:
 *   - False blocking is worse than imperfect routing.
 *   - Anything below 0.70 confidence falls through to the BOS engine to
 *     avoid trapping real work at the front door.
 *
 * This module imports nothing from @workspace/db so the bare node ESM
 * unit-test loader can require it directly. Mirrors finalStateHelpers /
 * memoryHelpers / consensusMerge pattern.
 */

export type FrontDoorRoute =
  | "GREETING"
  | "EMPTY"
  | "UNDER_SPECIFIED"
  | "LIKELY_NON_TASK"
  | "VALID_TASK";

export interface FrontDoorClassification {
  route: FrontDoorRoute;
  confidence: number; // 0.0 - 1.0
  rationale: string;
  shouldInvokeBosEngine: boolean;
  /** Detected signals — surfaced for audit + debugging. */
  signals: string[];
}

export interface FrontDoorContext {
  /** True when the user attached files to the task. Attachments alone
   * upgrade an otherwise vague prompt ("debug this") into a real task. */
  has_attachments?: boolean;
}

// === Signal vocabularies ====================================================

const EXACT_GREETINGS = new Set([
  "hello", "hi", "hey", "yo", "sup", "hola", "hiya",
  "good morning", "good afternoon", "good evening", "good night",
  "morning", "afternoon", "evening",
  "hello there", "hi there", "hey there",
  "howdy", "greetings",
  "thanks", "thank you", "thx", "ty",
  "ok", "okay", "k", "cool", "nice",
]);

// Signals that strongly indicate a real BOS-shaped task. Each match adds
// score; multiple matches compound (capped at 1.0).
const TASK_VERBS = [
  "review", "analyze", "analyse", "evaluate", "compare", "decide",
  "determine", "approve", "reject", "assess", "audit", "test", "validate",
  "fix", "debug", "build", "plan", "design", "implement", "summarize",
  "summarise", "explain", "investigate", "diagnose", "remediate",
  "draft", "write", "compose", "outline", "scope", "estimate",
];

const DECISION_NOUNS = [
  "risk", "risks", "safe", "unsafe", "secure", "vulnerable",
  "contract", "agreement", "vendor", "supplier", "pr", "pull request",
  "code", "architecture", "workflow", "document", "proposal", "policy",
  "migration", "deployment", "release", "merge", "incident", "outage",
  "compliance", "regulation", "liability", "exposure", "threat",
];

const INTERROGATIVE_DECISION_PHRASES = [
  /\bshould\s+(we|i|they|you)\b/i,
  /\bis\s+(this|it|that)\s+(safe|risky|secure|valid|correct|appropriate|acceptable)\b/i,
  /\bwhat\s+(are|is)\s+the\s+(risks?|implications?|trade-?offs?|consequences?)\s+/i,
  /\bcan\s+(we|i)\s+(safely|reliably)\b/i,
  /\bhow\s+do\s+(we|i)\s+(handle|mitigate|fix|debug|build|implement)\b/i,
];

// Casual/conversational patterns that aren't BOS tasks.
const NON_TASK_PATTERNS = [
  /\b(how('?s| is) it going|what'?s up|how are you|nice to meet you)\b/i,
  /\b(tell me a joke|sing a song|write a poem about)\b/i,
  /\b(who are you|what are you|what can you do)\b/i,
  /\b(make me|build me)\s+(a\s+)?(sandwich|coffee|drink|meal)\b/i,
];

// Vague/short stubs that need more context.
const VAGUE_PRONOUN_PATTERNS = [
  /^(this|that|it|those|these)\.?$/i,
  /^(thoughts|ideas|opinions|advice|help)\??$/i,
  /^(fix|debug|review|analyze|check)\s+(this|that|it)\.?$/i,
  /^(what now|now what|next|what next)\??$/i,
];

// === Public API =============================================================

export function classifyFrontDoorInput(
  rawInput: string | undefined | null,
  ctx: FrontDoorContext = {},
): FrontDoorClassification {
  const text = (rawInput ?? "").trim();
  const lower = text.toLowerCase();
  const signals: string[] = [];

  // 1. EMPTY — deterministic, certainty 1.0.
  if (text.length === 0) {
    signals.push("empty_input");
    return {
      route: "EMPTY",
      confidence: 1.0,
      rationale: "Input is empty.",
      shouldInvokeBosEngine: false,
      signals,
    };
  }

  // 2. GREETING — exact match against the greeting set, optionally with
  // a trailing punctuation char. Multi-word greetings ("good morning")
  // are matched too. We strip trailing ! ? . , and surrounding quotes.
  const greeting_key = lower.replace(/^["'`]+|["'`]+$/g, "").replace(/[!?.,]+$/, "").trim();
  if (EXACT_GREETINGS.has(greeting_key)) {
    signals.push("exact_greeting");
    return {
      route: "GREETING",
      confidence: 0.98,
      rationale: "Input is a pure greeting / acknowledgement.",
      shouldInvokeBosEngine: false,
      signals,
    };
  }

  // 3. Score the input on three axes: valid_task, under_specified, non_task.
  const score = scoreInput(lower, text, ctx, signals);

  // VALID_TASK ≥ 0.75 → route through BOS.
  if (score.validTaskScore >= 0.75) {
    return {
      route: "VALID_TASK",
      confidence: round(score.validTaskScore),
      rationale: score.rationale,
      shouldInvokeBosEngine: true,
      signals,
    };
  }

  // UNDER_SPECIFIED ≥ 0.75 → ask for more context.
  if (score.underSpecifiedScore >= 0.75) {
    return {
      route: "UNDER_SPECIFIED",
      confidence: round(score.underSpecifiedScore),
      rationale: "Input appears task-related but lacks sufficient object/context.",
      shouldInvokeBosEngine: false,
      signals,
    };
  }

  // LIKELY_NON_TASK ≥ 0.75 → return BOS usage guidance.
  if (score.nonTaskScore >= 0.75) {
    return {
      route: "LIKELY_NON_TASK",
      confidence: round(score.nonTaskScore),
      rationale: "Input does not appear to request a BOS decision/review/build task.",
      shouldInvokeBosEngine: false,
      signals,
    };
  }

  // 4. LOW_CONFIDENCE SAFETY RULE — fall through to BOS rather than
  // falsely block real work.
  signals.push("low_confidence_fallthrough");
  return {
    route: "VALID_TASK",
    confidence: 0.5,
    rationale: "Ambiguous input; routing to BOS engine to avoid false blocking.",
    shouldInvokeBosEngine: true,
    signals,
  };
}

// === Scoring ================================================================

interface ScoreResult {
  validTaskScore: number;
  underSpecifiedScore: number;
  nonTaskScore: number;
  rationale: string;
}

function scoreInput(
  lower: string,
  raw: string,
  ctx: FrontDoorContext,
  signals: string[],
): ScoreResult {
  const tokens = lower.match(/[a-z][a-z0-9_-]*/g) ?? [];
  const tokenSet = new Set(tokens);
  const wordCount = tokens.length;

  let validScore = 0;
  let underSpecifiedScore = 0;
  let nonTaskScore = 0;
  const rationales: string[] = [];

  // --- Action verbs.
  let verbHits = 0;
  for (const v of TASK_VERBS) {
    if (tokenSet.has(v)) {
      verbHits++;
    }
  }
  if (verbHits > 0) {
    signals.push(`action_verbs:${verbHits}`);
    validScore += Math.min(0.45, 0.25 + (verbHits - 1) * 0.1);
    rationales.push(`detected ${verbHits} task verb(s)`);
  }

  // --- Decision nouns / domain objects.
  let nounHits = 0;
  for (const n of DECISION_NOUNS) {
    // Multi-word noun phrases need a substring check.
    if (n.includes(" ") ? lower.includes(n) : tokenSet.has(n)) {
      nounHits++;
    }
  }
  if (nounHits > 0) {
    signals.push(`decision_nouns:${nounHits}`);
    validScore += Math.min(0.35, 0.2 + (nounHits - 1) * 0.075);
    rationales.push(`detected ${nounHits} decision noun(s)`);
  }

  // --- Interrogative decision phrasing (compounds with verbs/nouns).
  for (const re of INTERROGATIVE_DECISION_PHRASES) {
    if (re.test(raw)) {
      signals.push("interrogative_decision_phrase");
      validScore += 0.35;
      rationales.push("interrogative decision phrasing");
      break;
    }
  }

  // --- Imperative short tasks: ≤ 4 words, starts with a task verb +
  // at least one object/noun token. e.g. "Review contract", "Plan migration".
  const firstToken = tokens[0];
  if (
    wordCount <= 4 &&
    firstToken &&
    TASK_VERBS.includes(firstToken) &&
    wordCount >= 2 &&
    nounHits >= 1
  ) {
    signals.push("imperative_task_phrase");
    validScore = Math.max(validScore, 0.85);
    rationales.push("imperative short task");
  }

  // --- Non-task / smalltalk signal. Architect-medium fix: do NOT
  // early-return here. Mixed-intent prompts ("who are you and review
  // this contract", "tell me a joke then analyze this PR") contain
  // real task verbs/nouns; we must not block them. Track the signal
  // and let the validScore comparison below decide.
  let nonTaskHit = false;
  for (const re of NON_TASK_PATTERNS) {
    if (re.test(raw)) {
      signals.push("non_task_pattern");
      nonTaskScore = 0.9;
      nonTaskHit = true;
      break;
    }
  }

  // --- Vague stub signal. Same fix: track instead of early-returning.
  let vagueHit = false;
  for (const re of VAGUE_PRONOUN_PATTERNS) {
    if (re.test(raw)) {
      signals.push("vague_pronoun_without_context");
      underSpecifiedScore = 0.9;
      vagueHit = true;
      // Attachments rescue vague stubs ("debug this" + a file).
      if (ctx.has_attachments) {
        signals.push("attached_context_present");
        underSpecifiedScore = 0;
        validScore = Math.max(validScore, 0.85);
      }
      break;
    }
  }

  // --- Attached context boosts everything (when not already counted by
  // the vague-rescue path above).
  if (ctx.has_attachments && !vagueHit) {
    signals.push("attached_context_present");
    validScore += 0.15;
  }

  // --- Length-based dampener: only verb, nothing else, no attachment →
  // under-specified (e.g. "review", "fix"). Only applies when no other
  // task signals (decision phrasing, nouns) exist — those would already
  // have lifted validScore above the threshold.
  if (
    verbHits >= 1 &&
    nounHits === 0 &&
    !ctx.has_attachments &&
    wordCount <= 2 &&
    validScore < 0.6
  ) {
    signals.push("verb_only_no_object");
    underSpecifiedScore = Math.max(underSpecifiedScore, 0.85);
  }

  // --- Mixed-intent priority: when the input contains BOTH a non-task
  // pattern AND real task signals, the task wins. This is the spec's
  // anti-false-block guarantee at work.
  if (nonTaskHit && validScore >= 0.45) {
    signals.push("mixed_intent_task_wins");
    nonTaskScore = 0;
    rationales.push("non-task preface but task signals present");
  }

  // Cap and produce.
  validScore = Math.min(1, validScore);
  return {
    validTaskScore: validScore,
    underSpecifiedScore: vagueHit && validScore >= 0.6 ? 0 : underSpecifiedScore,
    nonTaskScore,
    rationale: rationales.length > 0
      ? rationales.join("; ")
      : nonTaskHit
      ? "Input matches a known non-task / smalltalk pattern."
      : vagueHit
      ? "Input is a vague stub without an object or context."
      : "No strong task or non-task signals detected.",
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
