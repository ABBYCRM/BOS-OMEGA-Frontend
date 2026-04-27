/**
 * Task #67 — Lattice continuity scratchpad writer.
 *
 * Persists a deterministic auto-summary of a completed task into the
 * scratchpad memory layer as `source="auto_summary"`. Designed to be
 * called from pipeline.ts immediately AFTER the TASK_COMPLETED audit
 * record is written, so that:
 *
 *   - The audit chain is complete even if the writer fails.
 *   - Writer failures never observably affect task output (the public
 *     contract says writer failures are non-fatal).
 *
 * The companion Canon row "BOS-OMEGA Scratchpad Summary Contract"
 * (frontDoorCanonSeed.ts) tells the model how to interpret these rows
 * when they re-appear in a later task's scratchpad context.
 */

import { db, memoryItemsTable } from "@workspace/db";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger.js";
import { auditLog } from "./auditEngine.js";
import { buildAutoSummary, type SummaryInputs } from "./scratchpadSummary.js";

export interface AutoSummaryRequest extends SummaryInputs {
  user_id: string | null;
}

/**
 * Writes one scratchpad row for the just-finished task. Never throws
 * — all errors are logged and swallowed. The pipeline calls this
 * inside its own try/catch as belt-and-suspenders, but the inner
 * try/catch here is the authoritative non-fatal boundary.
 */
export async function writeAutoSummary(req: AutoSummaryRequest): Promise<{ memory_id: string } | null> {
  try {
    // Task #67 — privacy guard: never write NULL-owned auto-summaries.
    // memoryEngine.selectLayer enforces strict per-user retrieval and
    // returns zero rows for anonymous callers, so a NULL-owned row is
    // unreachable AND unsafe (any future relaxation of the retrieval
    // guard would leak it cross-tenant). Anonymous tasks therefore
    // skip the writer entirely; this is observably non-fatal because
    // pinning is the only manual continuity surface and pinning
    // already requires authentication.
    if (req.user_id === null) {
      logger.debug(
        { task_id: req.task_id },
        "writeAutoSummary skipped (anonymous task — no per-user owner)",
      );
      return null;
    }
    const { title, content } = buildAutoSummary(req);
    const id = randomUUID();
    await db.insert(memoryItemsTable).values({
      id,
      user_id: req.user_id,
      layer: "scratchpad",
      // authority_level=3: auto-summaries should sit BELOW manual pins
      // (which write at 5) and well below canon (10). The reranker uses
      // authority_level as a tiebreaker so this keeps human signal on top.
      authority_level: 3,
      title,
      content,
      source: "auto_summary",
      // Task #67 — record the originating task_id on the scratchpad row
      // itself so the Settings panel can render a link back to the task,
      // and so a future LLM-driven summariser can join back to the task
      // metadata without parsing the title.
      source_task_id: req.task_id,
    });
    await auditLog(
      req.task_id,
      "SCRATCHPAD_AUTO_WRITTEN",
      `Scratchpad auto-summary written for task ${req.task_id}`,
      { memory_id: id, user_id: req.user_id, source: "auto_summary", source_task_id: req.task_id },
    );
    return { memory_id: id };
  } catch (err) {
    logger.warn(
      { err, task_id: req.task_id, user_id: req.user_id },
      "writeAutoSummary failed (non-fatal — task output is unaffected)",
    );
    return null;
  }
}
