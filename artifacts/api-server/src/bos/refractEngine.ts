/**
 * BOS-OMEGA Refraction Engine — 5-perspective lens synthesis.
 *
 * The user said: "add refraction to the runtime".
 *
 * Refraction = pass the question through 5 different "lenses" the way light
 * passes through a prism and splits into a spectrum. Each lens asks a
 * different professional perspective on the same input:
 *
 *   TECHNICAL   — code, systems, data, math, engineering tradeoffs
 *   BUSINESS    — cost, ROI, time, stakeholder, organizational impact
 *   USER        — UX, friction, accessibility, human behavior
 *   RISK        — what could go wrong, edge cases, failure modes
 *   ADVERSARIAL — what would a critic / red-teamer / hostile user say
 *
 * The final answer is a 5-section synthesis of the 5 lens outputs, with
 * a top-line conclusion that pulls them together. The mode is designed
 * to be the operator's "think about this from every angle" button —
 * better than BTO (which spreads across many models) when the operator
 * wants STRUCTURED multi-perspective coverage of ONE question rather
 * than many parallel takes.
 *
 * Each lens call uses a single best-fit model so the operator can see
 * exactly which provider answered which perspective in the audit chain.
 * If a lens fails, the failure is recorded and the synthesis still
 * proceeds with the surviving lenses — refraction is structured
 * multi-perspective, not consensus-by-vote.
 */

import { db } from "@workspace/db";
import { executionRunsTable, parallelAgentsTable, synthesisReportsTable } from "@workspace/db";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import type { BosOutput, LLMCallResult, ModelScore, TaskContext } from "./types.js";
import { validateOutput } from "./validationEngine.js";
import { auditLog } from "./auditEngine.js";
import { callProvider } from "./executionEngine.js";
import { recordSuccess, recordFailure } from "./circuitBreaker.js";

export type RefractLens = "TECHNICAL" | "BUSINESS" | "USER" | "RISK" | "ADVERSARIAL";

const LENS_ORDER: RefractLens[] = ["TECHNICAL", "BUSINESS", "USER", "RISK", "ADVERSARIAL"];

const LENS_PROMPTS: Record<RefractLens, string> = {
  TECHNICAL: `=== LENS: TECHNICAL ===
You are the Technical Lens. Your job is to answer the operator's question
through the eyes of a senior engineer / systems architect. Focus on:
- How the thing actually works (or would work) under the hood
- Code, schemas, APIs, data flows, dependencies
- Engineering tradeoffs (performance vs complexity, build vs buy)
- Concrete technical steps the operator would actually take
Skip the business case, skip the UX, skip the risk — those are other
lenses. You own the "how does it work and how do I build it" angle.`,

  BUSINESS: `=== LENS: BUSINESS ===
You are the Business Lens. Your job is to answer the operator's question
through the eyes of a CEO / strategy lead / operator-of-the-business. Focus on:
- Cost (dollars, hours, opportunity cost)
- ROI, payback period, expected value
- Stakeholder impact (who cares, who pays, who blocks)
- Organizational / operational implications
Skip the engineering details, skip the UX, skip the risk — those are
other lenses. You own the "is this worth doing and what does it cost" angle.`,

  USER: `=== LENS: USER ===
You are the User Lens. Your job is to answer the operator's question
through the eyes of the end user / customer / human on the receiving end.
Focus on:
- What does the user actually experience
- Friction, confusion, delight, accessibility
- Behavior change: what would the user do differently after this
- Emotional and cognitive load
Skip the engineering, skip the business case, skip the risk — those are
other lenses. You own the "what does this feel like to a real person" angle.`,

  RISK: `=== LENS: RISK ===
You are the Risk Lens. Your job is to answer the operator's question
through the eyes of a risk officer / SRE / compliance lead. Focus on:
- What could go wrong (failure modes, edge cases, blast radius)
- Reversibility: is this a one-way door or two-way door
- Compliance, regulatory, legal exposure
- Detection: how would we notice if it broke
Skip the engineering details, skip the business case, skip the UX —
those are other lenses. You own the "what kills us" angle.`,

  ADVERSARIAL: `=== LENS: ADVERSARIAL ===
You are the Adversarial Lens. Your job is to answer the operator's
question through the eyes of a critic / red-teamer / hostile reviewer.
Focus on:
- What's wrong with the obvious answer
- What assumptions are unstated and probably wrong
- What would break the plan
- The "I don't buy it" objection — name it, then engage with it
Be specific. Generic "but what about edge cases" is not enough. Pick the
single strongest counter-argument and make it. Skip the engineering,
skip the business case, skip the UX, skip the risk — those are other
lenses. You own the "but actually" angle.`,
};

const SYNTHESIS_PROMPT = `=== REFRACTION SYNTHESIS ===
You are the synthesis layer for a 5-lens refraction. You received five
specialist perspectives on the operator's question:

  TECHNICAL   — how it works
  BUSINESS    — what it costs
  USER        — what it feels like
  RISK        — what kills us
  ADVERSARIAL — what's wrong with the obvious answer

Your job: produce ONE consolidated answer that:
1. Leads with a one-paragraph TOP-LINE conclusion that resolves the
   tensions between the 5 lenses.
2. Then gives 5 short labeled sections (one per lens), each
   2-4 sentences pulling out the single most actionable insight from
   that lens.
3. Ends with a RECOMMENDED NEXT ACTION — the single concrete thing
   the operator should do first.

Do NOT just concatenate the 5 lens outputs — synthesize them. If the
TECHNICAL lens says "X is feasible" and the RISK lens says "X is
reversible but slow", your top-line should reconcile that ("X is
feasible and reversible, so the RISK lens's slow-rollout concern is
the binding constraint — start with a 1-week pilot"). State = GO.
The operator wants ONE answer, not five.`;

/**
 * Run a 5-lens refraction. Each lens gets its own model call; failures
 * are recorded but the synthesis still runs on whatever lenses survived.
 * The final answer is the synthesis report (one model call to a
 * best-fit model) wrapped in the BOS output schema.
 */
export async function executeRefract(
  ctx: TaskContext,
  selected_models: ModelScore[],
  memory_context: string,
): Promise<{ result: BosOutput; attempts_saved: string[] }> {
  const run_id = randomUUID();
  const attempts_saved: string[] = [];

  await db.insert(executionRunsTable).values({
    id: run_id,
    task_id: ctx.task_id,
    mode: "refract",
    status: "running",
    started_at: new Date(),
  });
  await auditLog(ctx.task_id, "REFRACT_STARTED",
    `Refraction: 5-lens analysis across ${selected_models.length} models`,
    { run_id, lens_count: LENS_ORDER.length },
  );

  // We need 5 distinct model selections, one per lens. If we have ≥5
  // models, use the first 5. Otherwise round-robin the available models
  // (a single model can cover multiple lenses — better than dropping a
  // lens entirely). If we have zero models, fail fast with a clear
  // error rather than crashing on the non-null assertion.
  if (selected_models.length === 0) {
    await db.update(executionRunsTable).set({ status: "failed", completed_at: new Date() }).where(eq(executionRunsTable.id, run_id));
    await auditLog(ctx.task_id, "REFRACT_ABORTED", "No models available for refraction");
    return {
      result: {
        state: "HOLD",
        task_type: ctx.task_type,
        answer: "BOS-OMEGA Refraction: no LLM providers are available. Check /api/providers for health and circuit-breaker status.",
        assumptions: [],
        uncertainties: ["The provider pool is empty (all providers disabled or in OPEN_CIRCUIT)."],
        missing_inputs: [],
        failure_modes: ["Provider pool empty — refraction cannot run."],
        recommended_next_action: "Check /api/providers, restore at least one healthy provider, then retry.",
      },
      attempts_saved,
    };
  }
  const models_per_lens = LENS_ORDER.map((_, i) => selected_models[i % selected_models.length]!);

  const lens_results: Array<{ lens: RefractLens; model: ModelScore; result: LLMCallResult; parsed: BosOutput | null }> = [];

  for (let i = 0; i < LENS_ORDER.length; i++) {
    const lens = LENS_ORDER[i]!;
    const model_info = models_per_lens[i]!;
    const lens_role_overlay = LENS_PROMPTS[lens];

    await auditLog(ctx.task_id, "REFRACT_LENS_STARTED",
      `Lens ${lens} via ${model_info.provider_name}/${model_info.model_name}`,
      { run_id, lens, provider: model_info.provider_name, model: model_info.model_name });

    const result = await callProvider(ctx, model_info, memory_context, {
      role_overlay: lens_role_overlay,
    });

    if (result.success && result.raw_response) {
      const validation = validateOutput(result.raw_response, ctx.task_type);
      const attempt_id = randomUUID();
      await db.insert(parallelAgentsTable).values({
        id: attempt_id,
        run_id,
        role: lens,
        provider: model_info.provider_name,
        model: model_info.model_name,
        state: validation.passed ? "GO" : "HOLD",
        output_snapshot: result.raw_response.slice(0, 8000),
        confidence_score: validation.confidence_score,
        latency_ms: result.latency_ms,
      });
      attempts_saved.push(attempt_id);
      await recordSuccess(model_info.provider_id, result.latency_ms);

      let parsed: BosOutput | null = null;
      try {
        const json_match = result.raw_response.match(/\{[\s\S]*\}/);
        if (json_match) {
          parsed = JSON.parse(json_match[0]) as BosOutput;
        }
      } catch {
        // synthesis layer will absorb the failure
      }
      lens_results.push({ lens, model: model_info, result, parsed });
      await auditLog(ctx.task_id, "REFRACT_LENS_COMPLETED",
        `Lens ${lens} via ${model_info.provider_name}/${model_info.model_name} → state=${parsed?.state ?? "unparseable"}`,
        { run_id, lens, provider: model_info.provider_name, model: model_info.model_name, state: parsed?.state ?? null });
    } else {
      await recordFailure(model_info.provider_id, result.error_type || "unknown_exception");
      await auditLog(ctx.task_id, "REFRACT_LENS_FAILED",
        `Lens ${lens} via ${model_info.provider_name}/${model_info.model_name} → ${result.error_type || "unknown_exception"}`,
        { run_id, lens, provider: model_info.provider_name, model: model_info.model_name, error_type: result.error_type });
      lens_results.push({ lens, model: model_info, result, parsed: null });
    }
  }

  const surviving = lens_results.filter((r) => r.parsed !== null);
  if (surviving.length === 0) {
    await db.update(executionRunsTable).set({ status: "failed", completed_at: new Date() }).where(eq(executionRunsTable.id, run_id));
    await auditLog(ctx.task_id, "TASK_HELD", "All 5 refract lenses failed");
    return {
      result: {
        state: "HOLD",
        task_type: ctx.task_type,
        answer: "BOS-OMEGA Refraction: all 5 lenses failed. The runtime could not produce a multi-perspective analysis. Try a different mode or check provider health.",
        assumptions: [],
        uncertainties: ["All 5 lens calls failed; no synthesis possible."],
        missing_inputs: [],
        failure_modes: ["Provider health degraded across the routing pool."],
        recommended_next_action: "Switch to single mode or check /api/providers for circuit-breaker status.",
      },
      attempts_saved,
    };
  }

  // Build the synthesis prompt: concatenate the surviving lens outputs.
  const lens_sections = surviving.map(({ lens, parsed, model }) => {
    return `--- ${lens} (${model.provider_name}/${model.model_name}) ---\n${parsed?.answer ?? "(no answer)"}\nState: ${parsed?.state ?? "?"}`;
  }).join("\n\n");

  const synthesis_input = `${SYNTHESIS_PROMPT}\n\nOperator's question:\n${ctx.input}\n\nLens outputs:\n${lens_sections}`;

  // Use the first surviving model for synthesis (could be a different
  // selection, but keeping it simple for now).
  const synthesis_model = surviving[0]!.model;
  await auditLog(ctx.task_id, "REFRACT_SYNTHESIS_STARTED",
    `Synthesizing ${surviving.length}/5 lens outputs via ${synthesis_model.provider_name}/${synthesis_model.model_name}`,
    { run_id, surviving_lenses: surviving.length });

  // Build a synthetic ctx-like for the synthesis call: same input but
  // with the lens outputs inlined. We piggyback on callProvider by
  // overriding attachment_context with the synthesis prompt.
  const synthesis_ctx: TaskContext = {
    ...ctx,
    input: synthesis_input,
    attachment_context: undefined,
  };
  const synthesis_result = await callProvider(synthesis_ctx, synthesis_model, memory_context, {
    role_overlay: "You are the synthesis layer. Produce a single consolidated answer that reconciles the 5 lens perspectives. State = GO unless the lenses reveal an actual unsafe condition. Be direct, lead with the top-line conclusion, then 5 short lens summaries, then a single recommended next action.",
  });

  if (!synthesis_result.success || !synthesis_result.raw_response) {
    await db.update(executionRunsTable).set({ status: "failed", completed_at: new Date() }).where(eq(executionRunsTable.id, run_id));
    await auditLog(ctx.task_id, "TASK_HELD", "Refract synthesis call failed");
    return {
      result: {
        state: "HOLD",
        task_type: ctx.task_type,
        answer: `BOS-OMEGA Refraction: ${surviving.length}/5 lenses succeeded but the synthesis call failed. The lens outputs are preserved in the audit chain.\n\n${lens_sections}`,
        assumptions: ["The synthesis layer could not run; the raw lens outputs are shown above instead."],
        uncertainties: ["The synthesis failed — you may want to retry or read the audit chain for the per-lens detail."],
        missing_inputs: [],
        failure_modes: ["Synthesis provider error: " + (synthesis_result.error_type ?? "unknown")],
        recommended_next_action: "Retry the task; if it persists, fall back to single mode.",
      },
      attempts_saved,
    };
  }

  const synthesis_validation = validateOutput(synthesis_result.raw_response, ctx.task_type);
  let synthesis_parsed: BosOutput;
  try {
    const json_match = synthesis_result.raw_response.match(/\{[\s\S]*\}/);
    synthesis_parsed = json_match ? JSON.parse(json_match[0]) as BosOutput : {
      state: "GO",
      task_type: ctx.task_type,
      answer: synthesis_result.raw_response,
      assumptions: [],
      uncertainties: [],
      missing_inputs: [],
      failure_modes: [],
      recommended_next_action: "",
    };
  } catch {
    synthesis_parsed = {
      state: "GO",
      task_type: ctx.task_type,
      answer: synthesis_result.raw_response,
      assumptions: [],
      uncertainties: ["Could not parse structured synthesis; showing raw."],
      missing_inputs: [],
      failure_modes: [],
      recommended_next_action: "",
    };
  }

  // Persist the synthesis report so the operator can re-read it later
  // and the audit chain has a clean record of "refraction was the
  // chosen mode, here's the synthesis".
  const synthesis_id = randomUUID();
  await db.insert(synthesisReportsTable).values({
    id: synthesis_id,
    run_id,
    summary: synthesis_parsed.answer.slice(0, 4000),
    confidence: synthesis_validation.confidence_score,
    sources: surviving.map((s) => `${s.lens}=${s.model.provider_name}/${s.model.model_name}`),
    state: synthesis_parsed.state,
  });

  await db.update(executionRunsTable).set({ status: "completed", completed_at: new Date() }).where(eq(executionRunsTable.id, run_id));
  await auditLog(ctx.task_id, "REFRACT_COMPLETED",
    `Refraction complete: ${surviving.length}/5 lenses, synthesis state=${synthesis_parsed.state}`,
    { run_id, surviving_lenses: surviving.length, synthesis_state: synthesis_parsed.state });

  // Enrich the synthesis answer with the per-lens model attribution so
  // the operator can see which model produced which lens.
  const attribution_footer = `\n\n---\n_5-lens refraction: ${surviving.map((s) => `${s.lens}=${s.model.provider_name}/${s.model.model_name}`).join(", ")}_`;
  synthesis_parsed.answer = synthesis_parsed.answer + attribution_footer;

  return { result: synthesis_parsed, attempts_saved };
}
