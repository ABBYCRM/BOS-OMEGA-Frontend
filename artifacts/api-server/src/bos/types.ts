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

export type ExecutionMode = "single" | "parallel" | "consensus";

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
}

export interface TaskContext {
  task_id: string;
  input: string;
  task_type: TaskType | string;
  tri_state: TriState;
  mode: ExecutionMode;
  parallel_models: number;
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
