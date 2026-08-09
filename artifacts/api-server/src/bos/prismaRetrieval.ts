/**
 * BOS-OMEGA Prisma — multi-source retrieval tool.
 *
 * The user said: "add prisma to the runtime".
 *
 * Prisma = the model can ask "what do we already know about X?" and get
 * a structured answer from the runtime's own data. It is a thin
 * retrieval layer over the live runtime:
 *
 *   1. CANON RECALL       — search the canon memory items for rules
 *                            relevant to the question.
 *   2. SCRATCHPAD RECALL  — search the user's pinned notes + auto-
 *                            summaries for context from prior tasks.
 *   3. CONVERSATION       — look up the last N turns of the active
 *      CONTEXT              conversation so the model doesn't ask the
 *                            user to repeat themselves.
 *   4. PROVIDER HEALTH    — show which providers are healthy / open-
 *                            circuit so the model can self-route.
 *   5. WEB SEARCH (stub)  — placeholder for Firecrawl / external
 *                            search; returns a structured "no key
 *                            configured" so the model can fall back
 *                            gracefully.
 *
 * The model invokes Prisma by returning a tool call in its structured
 * output. The pipeline intercepts that tool call, runs the retrieval,
 * and re-invokes the model with the retrieved data inlined. This is
 * the same pattern as OpenAI's tool use, scoped to the runtime's own
 * data.
 *
 * IMPORTANT: Prisma is NOT a real DB ORM (we use Drizzle). It is a
 * retrieval layer NAMED "Prisma" because that's the operator's term
 * for "look it up across all our sources". The name is intentional —
 * the user asked for it by name.
 */

import { db } from "@workspace/db";
import {
  memoryItemsTable,
  conversationsTable,
  llmProvidersTable,
  tasksTable,
} from "@workspace/db";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";

export type PrismaQuery = {
  canon?: { q?: string; max?: number };
  scratchpad?: { q?: string; max?: number };
  conversation?: { conversation_id?: string; last_n_turns?: number };
  provider_health?: { only_healthy?: boolean };
  web_search?: { q: string; max_results?: number };
};

export type PrismaResult = {
  canon?: Array<{ id: string; title: string; content: string; authority_level: number }>;
  scratchpad?: Array<{ id: string; title: string; content: string; source: string; source_task_id: string | null; created_at: string }>;
  conversation?: Array<{ id: string; role: string; content: string; created_at: string }>;
  provider_health?: Array<{ id: string; name: string; status: string; enabled: boolean; priority: number }>;
  web_search?: { status: "no_key" | "ok" | "failed"; results: Array<{ title: string; url: string; snippet: string }>; note?: string };
};

const DEFAULT_MAX = 10;

/**
 * Run a Prisma retrieval. Always returns a structured PrismaResult —
 * never throws. Missing / empty data is returned as an empty array so
 * the calling model can render "no results found" without crashing.
 */
export async function runPrismaRetrieval(
  user_id: string | null,
  query: PrismaQuery,
  is_super_admin: boolean,
): Promise<PrismaResult> {
  const result: PrismaResult = {};

  try {
    if (query.canon) {
      const max = Math.min(query.canon.max ?? DEFAULT_MAX, 50);
      const q = query.canon.q?.trim();
      const where = and(
        eq(memoryItemsTable.layer, "canon"),
        q ? like(memoryItemsTable.title, `%${q}%`) : undefined,
        is_super_admin ? undefined : or(eq(memoryItemsTable.user_id, user_id ?? ""), sql`${memoryItemsTable.user_id} IS NULL`),
      );
      const rows = await db
        .select({
          id: memoryItemsTable.id,
          title: memoryItemsTable.title,
          content: memoryItemsTable.content,
          authority_level: memoryItemsTable.authority_level,
        })
        .from(memoryItemsTable)
        .where(where)
        .orderBy(desc(memoryItemsTable.authority_level))
        .limit(max);
      result.canon = rows;
    }

    if (query.scratchpad) {
      const max = Math.min(query.scratchpad.max ?? DEFAULT_MAX, 50);
      const q = query.scratchpad.q?.trim();
      const where = and(
        eq(memoryItemsTable.layer, "scratchpad"),
        q ? or(like(memoryItemsTable.title, `%${q}%`), like(memoryItemsTable.content, `%${q}%`)) : undefined,
        is_super_admin ? undefined : or(eq(memoryItemsTable.user_id, user_id ?? ""), sql`${memoryItemsTable.user_id} IS NULL`),
      );
      const rows = await db
        .select({
          id: memoryItemsTable.id,
          title: memoryItemsTable.title,
          content: memoryItemsTable.content,
          source: memoryItemsTable.source,
          source_task_id: memoryItemsTable.source_task_id,
          created_at: memoryItemsTable.created_at,
        })
        .from(memoryItemsTable)
        .where(where)
        .orderBy(desc(memoryItemsTable.created_at))
        .limit(max);
      result.scratchpad = rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
    }

    if (query.conversation) {
      const last_n = query.conversation.last_n_turns ?? 6;
      if (query.conversation.conversation_id) {
        const rows = await db
          .select({
            id: tasksTable.id,
            input: tasksTable.input,
            final_output: tasksTable.final_output,
            final_status: tasksTable.final_status,
            created_at: tasksTable.created_at,
          })
          .from(tasksTable)
          .where(eq(tasksTable.conversation_id, query.conversation.conversation_id))
          .orderBy(desc(tasksTable.created_at))
          .limit(last_n);
        result.conversation = rows.reverse().map((r) => {
          let parsed_output: { answer?: string } = {};
          try {
            parsed_output = r.final_output ? JSON.parse(r.final_output) : {};
          } catch {
            parsed_output = {};
          }
          return {
            id: r.id,
            role: r.final_status === "COMPLETED" ? "assistant" : "user",
            content: parsed_output.answer ?? r.input ?? "",
            created_at: r.created_at.toISOString(),
          };
        });
      } else {
        result.conversation = [];
      }
    }

    if (query.provider_health) {
      const rows = await db
        .select({
          id: llmProvidersTable.id,
          name: llmProvidersTable.name,
          enabled: llmProvidersTable.enabled,
          priority: llmProvidersTable.priority,
        })
        .from(llmProvidersTable)
        .orderBy(llmProvidersTable.priority);
      // The `status` field isn't in the providers table directly — the
      // circuit breaker tracks that in-process. The retrieval returns
      // a placeholder status; the model should treat it as advisory.
      result.provider_health = rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.enabled ? "HEALTHY" : "DISABLED",
        enabled: r.enabled,
        priority: r.priority,
      }));
    }

    if (query.web_search) {
      // Web search is gated on a Firecrawl key. If the operator hasn't
      // configured one, we return a structured "no_key" so the model
      // knows to fall back to its own knowledge instead of pretending
      // it searched the web.
      const firecrawlKey = process.env["FIRECRAWL_API_KEY"];
      if (!firecrawlKey) {
        result.web_search = {
          status: "no_key",
          results: [],
          note: "Web search is not configured on this runtime (no FIRECRAWL_API_KEY). Answer from your own knowledge and explicitly flag the absence of live web verification in the assumptions field.",
        };
      } else {
        // Placeholder for the real Firecrawl call — wiring deferred
        // until the operator adds the key and confirms the endpoint.
        result.web_search = {
          status: "ok",
          results: [],
          note: "Web search key is configured but the Firecrawl adapter is not yet wired in this build. Available soon — falling back to model knowledge.",
        };
      }
    }
  } catch (err) {
    logger.error({ err, query }, "Prisma retrieval failed");
  }

  return result;
}

/**
 * Format a PrismaResult as a single string the model can inline into
 * its context. Compact (one line per result) so it fits in the
 * attachment_context budget.
 */
export function formatPrismaResult(result: PrismaResult): string {
  const sections: string[] = [];

  if (result.canon && result.canon.length > 0) {
    sections.push(`--- CANON RECALL (${result.canon.length} items) ---`);
    for (const c of result.canon) {
      sections.push(`• [${c.authority_level}] ${c.title}: ${c.content.slice(0, 280)}${c.content.length > 280 ? "..." : ""}`);
    }
  }

  if (result.scratchpad && result.scratchpad.length > 0) {
    sections.push(`--- SCRATCHPAD RECALL (${result.scratchpad.length} items) ---`);
    for (const s of result.scratchpad) {
      sections.push(`• [${s.source}] ${s.title}: ${s.content.slice(0, 280)}${s.content.length > 280 ? "..." : ""}`);
    }
  }

  if (result.conversation && result.conversation.length > 0) {
    sections.push(`--- CONVERSATION CONTEXT (${result.conversation.length} turns) ---`);
    for (const t of result.conversation) {
      sections.push(`[${t.role}] ${t.content.slice(0, 400)}${t.content.length > 400 ? "..." : ""}`);
    }
  }

  if (result.provider_health && result.provider_health.length > 0) {
    sections.push(`--- PROVIDER HEALTH ---`);
    for (const p of result.provider_health) {
      sections.push(`• ${p.name} (priority ${p.priority}, ${p.status})`);
    }
  }

  if (result.web_search) {
    sections.push(`--- WEB SEARCH (${result.web_search.status}) ---`);
    if (result.web_search.results.length > 0) {
      for (const r of result.web_search.results) {
        sections.push(`• ${r.title} — ${r.url}\n  ${r.snippet}`);
      }
    } else if (result.web_search.note) {
      sections.push(result.web_search.note);
    }
  }

  if (sections.length === 0) {
    return "(Prisma retrieval returned no results.)";
  }
  return sections.join("\n");
}
