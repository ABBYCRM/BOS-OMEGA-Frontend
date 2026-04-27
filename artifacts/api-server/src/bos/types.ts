export type TriState = "GO" | "HOLD" | "ABORT";

export type TaskType =
  | "legal"
  | "code"
  | "math"
  | "research"
  | "summarization"
  | "extraction"
  | "planning"
  | "creative"
  | "safety_review"
  | "general";

export type ExecutionMode = "single" | "parallel" | "consensus" | "series_pass" | "boil_the_ocean" | "auto";

export type ProviderStatus = "HEALTHY" | "DEGRADED" | "OPEN_CIRCUIT" | "RECOVERY_TEST";

export type ErrorClass =
  | "INPUT_ERROR"
  | "ROUTING_ERROR"
  | "API_ERROR"
  | "OUTPUT_ERROR"
  | "MEMORY_ERROR"
  | "SYSTEM_ERROR";

export type ErrorType =
  | "missing_input"
  | "malformed_input"
  | "ambiguous_task"
  | "unsafe_request"
  | "no_model_available"
  | "model_lacks_capability"
  | "provider_disabled"
  | "cost_limit_exceeded"
  | "timeout"
  | "rate_limit"
  | "auth_failure"
  | "quota_exceeded"
  | "provider_outage"
  | "malformed_response"
  | "schema_failure"
  | "incomplete_answer"
  | "instruction_drift"
  | "contradiction"
  | "hallucination_risk"
  | "unsafe_output"
  | "memory_unavailable"
  | "stale_memory"
  | "conflicting_memory"
  | "missing_canon"
  | "db_failure"
  | "env_missing"
  | "queue_failure"
  | "unknown_exception";

export interface BosOutput {
  state: TriState;
  task_type: TaskType | string;
  answer: string;
  assumptions: string[];
  uncertainties: string[];
  missing_inputs: string[];
  failure_modes: string[];
  recommended_next_action: string;
  parallel_responses?: ParallelResponse[];
  merge_strategy?: string;
  /** True when the repair engine had to patch the model output. */
  repair_applied?: boolean;
  /** Plain-English explanation of the governance decision (HOLD/ABORT only). */
  why_decision_was_made?: string;
  /** Allowed alternative path the user can take when blocked or held. */
  safe_alternative?: string;
  /**
   * BOP.FRONT_DOOR.v1 — set when the BOS engine was NOT invoked because
   * the Front Door Interpreter routed the input to UX guidance.
   * One of: "GREETING" | "EMPTY" | "UNDER_SPECIFIED" | "LIKELY_NON_TASK".
   * The frontend renders a friendly "GUIDANCE" pill instead of "HOLD"
   * when this is set.
   */
  front_door_route?: string;
  /** Example prompts surfaced alongside the front-door guidance. */
  front_door_examples?: string[];
}

export interface ParallelResponse {
  provider: string;
  model: string;
  state: TriState;
  answer: string;
  confidence_score: number;
  latency_ms: number;
  selected: boolean;
}

export interface ModelScore {
  model_id: string;
  provider_id: string;
  provider_name: string;
  model_name: string;
  score: number;
  capability_match: number;
  reliability_score: number;
  context_fit: number;
  latency_score: number;
  cost_score: number;
  provider_health_score: number;
  capability_tags: string[];
}

export type Persona = "legal" | "engineering" | "cyber";

export interface TaskContext {
  task_id: string;
  input: string;
  task_type: TaskType | string;
  tri_state: TriState;
  mode: ExecutionMode;
  parallel_models: number;
  attachment_context?: string;
  attachment_images?: VisionImage[];
  /** Optional domain-persona overlay applied to every model call in this task. */
  persona?: Persona | string;
  /**
   * Pre-rendered memory context (canon + continuity + patches + scratchpad)
   * computed by the orchestrator once per task, then handed to every
   * execution engine. Engines must consume this rather than fetching
   * memory themselves so all five modes share the same retrieval path.
   */
  memory_context?: string;
}

export interface VisionImage {
  /** RFC 2046 mime type, e.g. "image/png" */
  mime: string;
  /** raw bytes (base64-encoded, no data: prefix) */
  base64: string;
  /** human-friendly source label e.g. filename or "frame 3 of video.mp4" */
  source?: string;
}

export interface LLMCallResult {
  success: boolean;
  raw_response?: string;
  parsed?: BosOutput;
  error_type?: ErrorType;
  error_message?: string;
  latency_ms: number;
  token_input?: number;
  token_output?: number;
  cost_estimate?: number;
  provider: string;
  model: string;
}

export interface ValidationReport {
  schema_pass: boolean;
  safety_pass: boolean;
  instruction_pass: boolean;
  completeness_pass: boolean;
  confidence_score: number;
  notes: string;
  passed: boolean;
}
