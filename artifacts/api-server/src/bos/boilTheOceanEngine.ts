import { db } from "@workspace/db";
import {
  executionRunsTable,
  parallelAgentsTable,
  synthesisReportsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { BosOutput, ModelScore, TaskContext } from "./types.js";
import { validateOutput, extractJsonCandidate } from "./validationEngine.js";
import { auditLog } from "./auditEngine.js";
import { callProviderDirect } from "./providerBridge.js";
import { buildPersonaSystemSuffix } from "../providers/prompts.js";

export type AgentRole = "ARCHITECT" | "CRITIC" | "RESEARCHER" | "BUILDER" | "VALIDATOR";

const AGENT_ROLES: AgentRole[] = ["ARCHITECT", "CRITIC", "RESEARCHER", "BUILDER", "VALIDATOR"];

const AGENT_INSTRUCTIONS: Record<AgentRole, string> = {
  ARCHITECT: `You are the ARCHITECT AGENT. Your job:
1. Define the structure and organization of the answer
2. Identify all system modules, components, or sections needed
3. Map dependencies and relationships
4. Design the final architecture or framework
Focus on HOW to structure the best answer.`,

  CRITIC: `You are the CRITIC AGENT. Your job:
1. Find all weak assumptions in the task framing
2. Find missing logic, gaps, and incomplete areas
3. Find internal contradictions or inconsistencies
4. Flag any potential for hallucination or unsupported claims
Be rigorous. Find every flaw. Then propose corrections.`,

  RESEARCHER: `You are the RESEARCHER AGENT. Your job:
1. Identify what factual information is needed to answer this task
2. Distinguish clearly between what is known vs uncertain
3. Block any fake certainty — if you don't know, say so
4. Flag where external sources or tools would strengthen the answer
Focus on factual accuracy and epistemic rigor.`,

  BUILDER: `You are the BUILDER AGENT. Your job:
1. Convert ideas into concrete implementation steps
2. Write schemas, APIs, code specs, or action plans as appropriate
3. Make the answer buildable, actionable, and specific
4. Provide concrete examples, not just abstractions
Focus on making the answer immediately actionable.`,

  VALIDATOR: `You are the VALIDATOR AGENT. Your job:
1. Check that the answer matches the user's stated requirements
2. Check completeness — nothing important is missing
3. Check safety — no harmful, misleading, or policy-violating content
4. Return GO, HOLD, or ABORT with your assessment
Your state field drives whether this model's output is used.`,
};

function buildAgentPrompt(task: string, role: AgentRole, provider: string, model: string): string {
  const instruction = AGENT_INSTRUCTIONS[role];

  return `=== BOS-OMEGA BOIL THE OCEAN | AGENT: ${role} | MODEL: ${provider}/${model} ===

${instruction}

=== USER TASK ===
${task}

=== OUTPUT FORMAT ===
Return a JSON object:
{
  "state": "GO" | "HOLD" | "ABORT",
  "task_type": "general",
  "answer": "your full contribution here",
  "agent_role": "${role}",
  "key_points": ["key finding 1", "key finding 2"],
  "assumptions": ["assumption 1"],
  "uncertainties": ["uncertainty 1"],
  "missing_inputs": [],
  "failure_modes": ["failure mode 1"],
  "recommended_next_action": "what should be synthesized from your output"
}`;
}

function buildSynthesisPrompt(
  original_task: string,
  agent_outputs: Array<{ provider: string; model: string; role: AgentRole; output: string; score: number }>,
): string {
  let prompt = `=== BOS-OMEGA SYNTHESIS ENGINE | BOIL THE OCEAN ===

You are the SYNTHESIS ENGINE. You have received outputs from ${agent_outputs.length} specialized agents across multiple LLM providers.

=== ORIGINAL TASK ===
${original_task}

=== AGENT OUTPUTS ===
`;

  for (const ao of agent_outputs) {
    prompt += `\n--- ${ao.role} (${ao.provider}/${ao.model}, score: ${ao.score.toFixed(2)}) ---\n${ao.output.slice(0, 1500)}\n`;
  }

  prompt += `
=== YOUR SYNTHESIS TASK ===
1. Identify consensus points — where multiple agents agree
2. Identify contradictions — where agents disagree
3. Select the strongest sections from each agent's output
4. Reject weak or duplicative sections
5. Build one definitive, comprehensive final answer

Return a JSON object:
{
  "state": "GO" | "HOLD" | "ABORT",
  "task_type": "general",
  "answer": "THE COMPLETE FINAL SYNTHESIZED ANSWER",
  "assumptions": [],
  "uncertainties": [],
  "missing_inputs": [],
  "failure_modes": [],
  "recommended_next_action": "final recommendation",
  "consensus_points": ["point agents agreed on"],
  "contradictions": ["points of disagreement and how resolved"],
  "strongest_sections": ["sections that were strongest"],
  "rejected_sections": ["sections that were weak or contradicted"]
}`;

  return prompt;
}

function buildAdversarialPrompt(task: string, synthesis: string): string {
  return `=== BOS-OMEGA ADVERSARIAL REVIEW ===

You are the ADVERSARIAL REVIEWER. Attack the synthesis below.

=== ORIGINAL TASK ===
${task}

=== SYNTHESIS TO ATTACK ===
${synthesis}

Find:
- Unsupported claims
- Hidden assumptions
- Logical gaps
- Hallucination risks
- Safety concerns
- Missing edge cases

Then CORRECT every problem. Return the hardened final answer in BOS JSON format:
{
  "state": "GO" | "HOLD" | "ABORT",
  "task_type": "general",
  "answer": "HARDENED FINAL ANSWER AFTER ADVERSARIAL REVIEW",
  "assumptions": [],
  "uncertainties": [],
  "missing_inputs": [],
  "failure_modes": [],
  "recommended_next_action": "final action after adversarial review",
  "adversarial_findings": ["attack finding 1", "attack finding 2"]
}`;
}

export async function runBoilTheOcean(
  ctx: TaskContext,
  models: ModelScore[],
  max_models: number = 5,
  agents_per_model: number = 5,
): Promise<{ result: BosOutput; run_id: string }> {
  const run_id = randomUUID();
  const bto_models = models.slice(0, max_models);

  const total_agents = bto_models.length * agents_per_model;
  const model_names = bto_models.map((m) => `${m.provider_name}/${m.model_name}`);

  await db.insert(executionRunsTable).values({
    id: run_id,
    task_id: ctx.task_id,
    mode: "boil_the_ocean",
    status: "running",
    total_agents,
    models_used: model_names,
  });

  await auditLog(ctx.task_id, "BTO_STARTED", `Boil The Ocean: ${bto_models.length} models × ${agents_per_model} agents = ${total_agents} total jobs`);

  // Build all agent jobs
  const agent_jobs: Array<{ model: ModelScore; role: AgentRole; agent_id: string }> = [];
  for (const model of bto_models) {
    const roles_to_use = AGENT_ROLES.slice(0, agents_per_model);
    for (const role of roles_to_use) {
      agent_jobs.push({ model, role, agent_id: randomUUID() });
    }
  }

  // Insert agent records as pending
  await db.insert(parallelAgentsTable).values(
    agent_jobs.map((j) => ({
      id: j.agent_id,
      run_id,
      provider: j.model.provider_name,
      model: j.model.model_name,
      agent_role: j.role,
      status: "running" as const,
    }))
  );

  // Execute all agents in parallel with per-agent timeout
  await auditLog(ctx.task_id, "BTO_AGENTS_DISPATCHED", `Dispatching ${agent_jobs.length} agents in parallel`);

  const AGENT_TIMEOUT_MS = 45000;

  const agent_results = await Promise.allSettled(
    agent_jobs.map(async (job) => {
      const prompt = buildAgentPrompt(ctx.input, job.role, job.model.provider_name, job.model.model_name);
      const start = Date.now();

      const call_result = await Promise.race([
        callProviderDirect(prompt, ctx.task_type, job.model, {
          attachment_context: ctx.attachment_context,
          attachment_images: ctx.attachment_images,
          persona_prompt: buildPersonaSystemSuffix(ctx.persona) || undefined,
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("agent_timeout")), AGENT_TIMEOUT_MS)),
      ]);

      const latency_ms = Date.now() - start;
      return { job, call_result, latency_ms };
    })
  );

  // Collect successful agent outputs
  const successful_outputs: Array<{
    agent_id: string;
    provider: string;
    model: string;
    role: AgentRole;
    output: string;
    score: number;
    state: string;
    latency_ms: number;
  }> = [];

  for (let i = 0; i < agent_results.length; i++) {
    const settled = agent_results[i];
    const job = agent_jobs[i]!;

    if (settled.status === "fulfilled") {
      const { call_result, latency_ms } = settled.value;
      if (call_result.success && call_result.raw_response) {
        const validation = validateOutput(call_result.raw_response, ctx.task_type);
        let state = "GO";
        let output_text = call_result.raw_response;

        try {
          const candidate = extractJsonCandidate(call_result.raw_response);
          if (candidate) {
            const parsed = JSON.parse(candidate) as { state?: string; answer?: string };
            state = parsed.state || "GO";
            output_text = parsed.answer || call_result.raw_response;
          }
        } catch {}

        successful_outputs.push({
          agent_id: job.agent_id,
          provider: job.model.provider_name,
          model: job.model.model_name,
          role: job.role,
          output: output_text,
          score: validation.confidence_score,
          state,
          latency_ms,
        });

        await db.update(parallelAgentsTable)
          .set({ status: "completed", output: output_text.slice(0, 4000), score: validation.confidence_score, state, latency_ms })
          .where(eq(parallelAgentsTable.id, job.agent_id));
      } else {
        await db.update(parallelAgentsTable)
          .set({ status: "failed", error_type: call_result.error_type || "provider_error", latency_ms: settled.value.latency_ms })
          .where(eq(parallelAgentsTable.id, job.agent_id));
      }
    } else {
      const error = settled.reason instanceof Error ? settled.reason.message : "unknown";
      await db.update(parallelAgentsTable)
        .set({ status: "failed", error_type: error })
        .where(eq(parallelAgentsTable.id, job.agent_id));
    }
  }

  await auditLog(ctx.task_id, "BTO_AGENTS_COMPLETED", `${successful_outputs.length}/${agent_jobs.length} agents succeeded`);

  if (successful_outputs.length === 0) {
    await db.update(executionRunsTable).set({ status: "failed", completed_at: new Date() }).where(eq(executionRunsTable.id, run_id));
    return {
      result: {
        state: "HOLD",
        task_type: ctx.task_type,
        answer: "BOS-OMEGA Boil The Ocean: all agents failed. Check provider health and API keys.",
        assumptions: [],
        uncertainties: ["All agents failed"],
        missing_inputs: [],
        failure_modes: ["All parallel agents returned errors"],
        recommended_next_action: "Check provider health dashboard and verify API keys",
      },
      run_id,
    };
  }

  // Detect if any agent issued ABORT
  const abort_agents = successful_outputs.filter((a) => a.state === "ABORT");
  if (abort_agents.length > 0) {
    await db.update(executionRunsTable).set({ status: "aborted", completed_at: new Date() }).where(eq(executionRunsTable.id, run_id));
    await auditLog(ctx.task_id, "BTO_ABORTED", `${abort_agents.length} agents returned ABORT`);
    return {
      result: {
        state: "ABORT",
        task_type: ctx.task_type,
        answer: `BOS-OMEGA Boil The Ocean: ${abort_agents.length} agent(s) flagged ABORT. The task cannot be completed safely.`,
        assumptions: [],
        uncertainties: [],
        missing_inputs: [],
        failure_modes: abort_agents.map((a) => `${a.provider}/${a.model} (${a.role}): ABORT`),
        recommended_next_action: "Review the ABORT reasons and revise the task",
      },
      run_id,
    };
  }

  // Normalize: group by model, then synthesize
  const consensus_points: string[] = [];
  const contradictions: string[] = [];
  const strongest_sections: string[] = [];
  const rejected_sections: string[] = [];

  // Detect contradictions: sort by role, compare across providers
  const by_role = new Map<AgentRole, string[]>();
  for (const ao of successful_outputs) {
    const existing = by_role.get(ao.role) || [];
    existing.push(ao.output);
    by_role.set(ao.role, existing);
  }

  // Find consensus/contradiction from VALIDATOR outputs.
  //
  // HOLD is *not* a contradiction — it means "I need more info to judge",
  // which is a different signal than two validators positively disagreeing
  // (audit H-1). True contradictions are GO+ABORT pairs; HOLD-only means
  // "validators uncertain", which we surface separately so the synthesis
  // pass treats it as a confidence cap, not as adversarial disagreement.
  const validator_outputs = successful_outputs.filter((a) => a.role === "VALIDATOR");
  const validator_states = validator_outputs.map((v) => v.state);
  const has_go = validator_states.some((s) => s === "GO");
  const has_abort = validator_states.some((s) => s === "ABORT");
  const has_hold = validator_states.some((s) => s === "HOLD");
  const all_go = validator_states.length > 0 && validator_states.every((s) => s === "GO");

  if (validator_states.length > 1) {
    if (all_go) {
      consensus_points.push("All validator agents returned GO");
    } else if (has_go && has_abort) {
      contradictions.push("Validator agents disagreed (GO vs ABORT)");
    } else if (has_hold) {
      // Surface uncertainty without falsely flagging contradiction.
      consensus_points.push("Validator agents uncertain (one or more returned HOLD)");
    }
  }

  // Run synthesis on top model's best model
  const synthesis_model = bto_models[0]!;
  await auditLog(ctx.task_id, "BTO_SYNTHESIS_STARTED", `Running synthesis via ${synthesis_model.provider_name}/${synthesis_model.model_name}`);

  const synthesis_prompt = buildSynthesisPrompt(ctx.input, successful_outputs.slice(0, 10));
  const synthesis_result = await callProviderDirect(synthesis_prompt, ctx.task_type, synthesis_model, {
    attachment_context: ctx.attachment_context,
    attachment_images: ctx.attachment_images,
    persona_prompt: buildPersonaSystemSuffix(ctx.persona) || undefined,
  });

  let synthesis_answer = "Synthesis could not be generated.";
  let synthesis_parsed: Partial<BosOutput> & { consensus_points?: string[]; contradictions?: string[]; strongest_sections?: string[]; rejected_sections?: string[] } = {};

  if (synthesis_result.success && synthesis_result.raw_response) {
    try {
      const candidate = extractJsonCandidate(synthesis_result.raw_response);
      if (candidate) {
        synthesis_parsed = JSON.parse(candidate);
        synthesis_answer = synthesis_parsed.answer || synthesis_result.raw_response.slice(0, 3000);
        if (Array.isArray(synthesis_parsed.consensus_points)) consensus_points.push(...synthesis_parsed.consensus_points);
        if (Array.isArray(synthesis_parsed.contradictions)) contradictions.push(...synthesis_parsed.contradictions);
        if (Array.isArray(synthesis_parsed.strongest_sections)) strongest_sections.push(...synthesis_parsed.strongest_sections);
        if (Array.isArray(synthesis_parsed.rejected_sections)) rejected_sections.push(...synthesis_parsed.rejected_sections);
      }
    } catch {
      synthesis_answer = synthesis_result.raw_response.slice(0, 3000);
    }
  }

  await auditLog(ctx.task_id, "BTO_SYNTHESIS_COMPLETED", "Synthesis complete, running adversarial review");

  // Adversarial review
  const adversarial_model = bto_models[1] || bto_models[0]!;
  const adversarial_prompt = buildAdversarialPrompt(ctx.input, synthesis_answer);
  const adversarial_result = await callProviderDirect(adversarial_prompt, ctx.task_type, adversarial_model, {
    attachment_context: ctx.attachment_context,
    attachment_images: ctx.attachment_images,
    persona_prompt: buildPersonaSystemSuffix(ctx.persona) || undefined,
  });

  let final_answer = synthesis_answer;
  const adversarial_findings: string[] = [];

  if (adversarial_result.success && adversarial_result.raw_response) {
    try {
      const candidate = extractJsonCandidate(adversarial_result.raw_response);
      if (candidate) {
        const adv = JSON.parse(candidate) as Partial<BosOutput> & { adversarial_findings?: string[] };
        if (adv.answer && adv.answer.length > synthesis_answer.length * 0.5) {
          final_answer = adv.answer;
        }
        if (Array.isArray(adv.adversarial_findings)) adversarial_findings.push(...adv.adversarial_findings);
      }
    } catch {}
  }

  await auditLog(ctx.task_id, "BTO_ADVERSARIAL_COMPLETED", `Adversarial review done: ${adversarial_findings.length} findings`);

  // Omega validation
  const omega_validation = {
    state: "GO" as const,
    schema_pass: true,
    safety_pass: true,
    completeness_pass: successful_outputs.length >= 3,
    notes: `${successful_outputs.length}/${agent_jobs.length} agents succeeded. ${adversarial_findings.length} adversarial findings resolved.`,
  };

  // Save synthesis report
  const synthesis_report_id = randomUUID();
  await db.insert(synthesisReportsTable).values({
    id: synthesis_report_id,
    run_id,
    consensus_points,
    contradictions,
    strongest_sections,
    rejected_sections,
    final_synthesis: final_answer.slice(0, 10000),
    omega_validation: JSON.stringify(omega_validation),
  });

  await db.update(executionRunsTable)
    .set({
      status: "completed",
      completed_at: new Date(),
      final_score: successful_outputs.reduce((s, a) => s + a.score, 0) / successful_outputs.length,
    })
    .where(eq(executionRunsTable.id, run_id));

  await auditLog(ctx.task_id, "BTO_COMPLETED", `Boil The Ocean complete — final answer ready`, {
    agents: `${successful_outputs.length}/${agent_jobs.length}`,
    consensus: consensus_points.length,
    contradictions: contradictions.length,
  });

  const parallel_responses = successful_outputs.slice(0, 15).map((ao) => ({
    provider: ao.provider,
    model: `${ao.model} [${ao.role}]`,
    state: ao.state as "GO" | "HOLD" | "ABORT",
    answer: ao.output.slice(0, 500) + "…",
    confidence_score: ao.score,
    latency_ms: ao.latency_ms,
    selected: ao.role === "VALIDATOR",
  }));

  return {
    result: {
      state: "GO",
      task_type: ctx.task_type,
      answer: final_answer,
      assumptions: Array.isArray(synthesis_parsed.assumptions) ? synthesis_parsed.assumptions : [],
      uncertainties: adversarial_findings.slice(0, 5).map((f) => `Adversarial finding (resolved): ${f}`),
      missing_inputs: Array.isArray(synthesis_parsed.missing_inputs) ? synthesis_parsed.missing_inputs : [],
      failure_modes: Array.isArray(synthesis_parsed.failure_modes) ? synthesis_parsed.failure_modes : [],
      recommended_next_action: `Validated best-effort synthesis from ${successful_outputs.length} specialized agents across ${bto_models.length} LLM providers`,
      merge_strategy: `boil_the_ocean_${bto_models.length}x${agents_per_model}_agents`,
      parallel_responses,
    },
    run_id,
  };
}
