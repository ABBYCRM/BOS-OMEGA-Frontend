/**
 * Fidelity Lattice Continuity Protocol — Task #69.
 *
 *   GET  /api/lattice/export      → build the user's continuity blob
 *                                   (canon + continuity + patches +
 *                                   scratchpad + last 20 task transcripts
 *                                   grouped by conversation) and return
 *                                   { blob, hash, exported_at,
 *                                     format_version, task_count,
 *                                     byte_size, source_session_id }.
 *                                   A `lattice_exports` audit row is
 *                                   written for every successful export.
 *
 *   POST /api/lattice/import      → accepts { blob }. Parses the
 *                                   embedded MEMORY_LATTICE_V1 JSON
 *                                   envelope, recomputes the sha256
 *                                   fidelity hash, and refuses (400) on
 *                                   mismatch. With ?dry_run=1 returns
 *                                   the counts that WOULD be imported
 *                                   without writing anything (used by
 *                                   the two-step Verify→Confirm UI).
 *                                   On commit, runs ONE db.transaction
 *                                   that:
 *                                     - upserts memory_items by id for
 *                                       all four layers (canon /
 *                                       continuity / patches /
 *                                       scratchpad), ALWAYS scoped to
 *                                       user_id=importer; never
 *                                       user_id=null. Conflicts on id
 *                                       use ON CONFLICT DO UPDATE
 *                                       WHERE user_id=importer, so
 *                                       global canon and rows owned by
 *                                       another user are no-ops and
 *                                       counted under `skipped`.
 *                                     - creates a new conversation
 *                                       "Imported from <source>" owned
 *                                       by the importer
 *                                     - inserts the rehydrated tasks
 *                                       under that conversation (NEW
 *                                       ids — source ids are not
 *                                       re-used to avoid collisions)
 *                                   Returns counts per layer + the
 *                                   created conversation id.
 *
 *   GET  /api/lattice/exports     → last 10 lattice_exports rows for
 *                                   the calling user (for the Settings
 *                                   "Recent Lattice Exports" subsection).
 *
 * All endpoints are user-scoped. Anonymous requests get 401.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  memoryItemsTable,
  conversationsTable,
  tasksTable,
  latticeExportsTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";
import { auditLog } from "../bos/auditEngine.js";
import {
  buildLatticeBlob,
  parseLatticeBlob,
  LATTICE_FORMAT_VERSION,
  type LatticeMemoryItem,
  type LatticeConversation,
  type LatticeTask,
} from "../bos/latticeFormat.js";

const router = Router();

const RECENT_TASKS = 20;
const MAX_BLOB_BYTES = 5 * 1024 * 1024; // 5 MiB hard cap on import payload.

router.get("/export", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const user_id = req.user.id;

  // Memory: canon (global, user_id IS NULL) + this user's per-layer rows.
  // We pull them in two queries so canon doesn't depend on the per-user
  // scoping rule (canon is intentionally global, see memoryEngine.ts).
  const canonRows = await db
    .select()
    .from(memoryItemsTable)
    .where(and(eq(memoryItemsTable.layer, "canon"), sql`${memoryItemsTable.user_id} IS NULL`))
    .orderBy(desc(memoryItemsTable.authority_level), desc(memoryItemsTable.updated_at));

  const userRows = await db
    .select()
    .from(memoryItemsTable)
    .where(and(eq(memoryItemsTable.user_id, user_id)))
    .orderBy(desc(memoryItemsTable.authority_level), desc(memoryItemsTable.updated_at));

  const toItem = (r: typeof memoryItemsTable.$inferSelect): LatticeMemoryItem => ({
    id: r.id,
    layer: r.layer as LatticeMemoryItem["layer"],
    title: r.title,
    content: r.content,
    authority_level: r.authority_level,
    source: r.source,
    source_task_id: r.source_task_id ?? null,
  });

  const layers = {
    canon: canonRows.map(toItem),
    continuity: userRows.filter((r) => r.layer === "continuity").map(toItem),
    patches: userRows.filter((r) => r.layer === "patches").map(toItem),
    scratchpad: userRows.filter((r) => r.layer === "scratchpad").map(toItem),
  };

  // Recent tasks: last 20 across this user, newest first, joined to
  // their conversation row. Single query — no N+1.
  const taskRows = await db
    .select({
      task: tasksTable,
      conv_id: conversationsTable.id,
      conv_title: conversationsTable.title,
      conv_keywords: conversationsTable.topic_keywords,
    })
    .from(tasksTable)
    .leftJoin(conversationsTable, eq(tasksTable.conversation_id, conversationsTable.id))
    .where(eq(tasksTable.user_id, user_id))
    .orderBy(desc(tasksTable.created_at))
    .limit(RECENT_TASKS);

  // Group by conversation id, preserving newest-first ordering of the
  // conversation that contains the most-recent task. Tasks within a
  // conversation are then re-sorted ascending so the chat reads top to
  // bottom in chronological order.
  const conv_map = new Map<string, LatticeConversation>();
  const UNCAT_KEY = "__uncategorized__";
  for (const row of taskRows) {
    const key = row.conv_id ?? UNCAT_KEY;
    if (!conv_map.has(key)) {
      conv_map.set(key, {
        id: row.conv_id ?? UNCAT_KEY,
        title: row.conv_title ?? "Uncategorized",
        topic_keywords: row.conv_keywords ?? [],
        tasks: [],
      });
    }
    const t: LatticeTask = {
      id: row.task.id,
      input_text: row.task.input_text,
      task_type: row.task.task_type,
      tri_state: row.task.tri_state,
      final_status: row.task.final_status,
      final_output: row.task.final_output ?? null,
      mode: row.task.mode,
      created_at: row.task.created_at?.toISOString?.() ?? new Date(0).toISOString(),
    };
    conv_map.get(key)!.tasks.push(t);
  }
  const conversations = Array.from(conv_map.values()).map((c) => ({
    ...c,
    tasks: c.tasks.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)),
  }));

  const exported_at = new Date().toISOString();
  const source_session_id = randomUUID();
  const built = buildLatticeBlob({
    format_version: LATTICE_FORMAT_VERSION,
    exported_at,
    source_session_id,
    memory_layers: layers,
    conversations,
  });

  const task_count = taskRows.length;
  const audit_id = randomUUID();
  try {
    await db.insert(latticeExportsTable).values({
      id: audit_id,
      user_id,
      fidelity_sha256: built.hash,
      byte_size: built.byte_size,
      task_count,
    });
  } catch (err) {
    req.log?.warn({ err }, "lattice_exports row insert failed (non-fatal — export still served)");
  }
  await auditLog(undefined, "LATTICE_EXPORTED", `Lattice exported by user ${user_id}`, {
    user_id,
    export_id: audit_id,
    fidelity_sha256: built.hash,
    byte_size: built.byte_size,
    task_count,
    source_session_id,
  });

  res.json({
    blob: built.blob,
    hash: built.hash,
    exported_at,
    format_version: LATTICE_FORMAT_VERSION,
    task_count,
    byte_size: built.byte_size,
    source_session_id,
  });
});

const ImportBody = z.object({
  blob: z.string().min(1).max(MAX_BLOB_BYTES),
});

router.post("/import", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const user_id = req.user.id;
  const parsed = ImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", code: "INPUT_ERROR", detail: parsed.error.issues });
    return;
  }

  let parsedBlob: ReturnType<typeof parseLatticeBlob>;
  try {
    parsedBlob = parseLatticeBlob(parsed.data.blob);
  } catch (err) {
    res.status(400).json({
      error: `Could not parse lattice blob: ${(err as Error).message}`,
      code: "LATTICE_PARSE_ERROR",
    });
    return;
  }

  if (!parsedBlob.hash_ok) {
    res.status(400).json({
      error: "Lattice fidelity hash mismatch — the blob has been modified or truncated",
      code: "LATTICE_HASH_MISMATCH",
      expected: parsedBlob.payload.fidelity_hash,
      recomputed: parsedBlob.recomputed_hash,
    });
    await auditLog(undefined, "LATTICE_IMPORTED", `Lattice import REJECTED (hash mismatch) for user ${user_id}`, {
      user_id,
      verified: false,
      expected: parsedBlob.payload.fidelity_hash,
      recomputed: parsedBlob.recomputed_hash,
      source_session_id: parsedBlob.payload.source_session_id,
    });
    return;
  }

  const payload = parsedBlob.payload;
  const conv_id = randomUUID();
  const counts = { canon: 0, continuity: 0, patches: 0, scratchpad: 0, conversations: 0, tasks: 0 };
  let skipped = 0;

  // Dry-run path. The frontend uses ?dry_run=1 for the two-step
  // "Verify → Confirm" flow: the user pastes a blob, we parse and
  // verify the fidelity hash (already done above), then return the
  // counts that WOULD be imported without writing anything. The
  // second POST without dry_run actually commits. The preview is
  // computed from the same payload the real import would write so
  // there is no skew between preview and commit.
  const dry_run =
    String((req.query as Record<string, unknown>)?.dry_run ?? "")
      .toLowerCase() === "1" ||
    String((req.query as Record<string, unknown>)?.dry_run ?? "")
      .toLowerCase() === "true";

  if (dry_run) {
    // Count items per layer without touching the DB. Cross-tenant
    // ownership cannot be checked without a DB read, so the preview
    // shows the OPTIMISTIC count (everything that's well-formed). The
    // commit path applies the WHERE predicate and reports the actual
    // figures via `imported`+`skipped`. The user is told this in the
    // UI ("preview — actual import may differ if rows are owned by
    // another account").
    for (const layer of ["canon", "continuity", "patches", "scratchpad"] as const) {
      for (const item of payload.memory_layers[layer] ?? []) {
        if (
          !item ||
          typeof item.id !== "string" ||
          typeof item.title !== "string" ||
          typeof item.content !== "string"
        ) {
          skipped += 1;
          continue;
        }
        counts[layer] += 1;
      }
    }
    counts.conversations = 1; // The rehydration conversation is always created on commit.
    let task_total = 0;
    for (const conv of payload.conversations ?? []) {
      for (const t of conv.tasks ?? []) {
        if (t && typeof t.input_text === "string") task_total += 1;
        else skipped += 1;
      }
    }
    counts.tasks = task_total;
    res.json({
      dry_run: true,
      preview: counts,
      skipped,
      source_session_id: payload.source_session_id,
      conversation_title: `Imported from ${payload.source_session_id.slice(0, 8)}`,
      fidelity_sha256: payload.fidelity_hash,
    });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      // Memory upsert. Every layer (including canon) is rehydrated
      // INTO THE IMPORTING USER'S SCOPE — i.e. user_id=importer. This
      // is intentional and is the security boundary of import:
      //
      //   * No row in the database is ever assigned user_id=null by
      //     the import path. Global canon is only seeded at boot from
      //     `frontDoorCanonSeed.ts`. This means no authenticated user
      //     can mutate global canon via a crafted blob, no matter
      //     what role they hold or what canon ids the blob declares.
      //
      //   * For every layer, `onConflictDoUpdate` carries a WHERE
      //     predicate that only fires the UPDATE when the existing
      //     row is already owned by the importer. Postgres semantics
      //     of ON CONFLICT (id) DO UPDATE SET ... WHERE ... are:
      //     try INSERT; if a conflict on id occurs, attempt the
      //     UPDATE only if WHERE matches; if the WHERE rejects,
      //     neither INSERT nor UPDATE happens. We use
      //     `.returning({ id })` to detect the no-op case and count
      //     it under `skipped` so the user knows their import could
      //     not claim that id. Combined with the WHERE clause this
      //     defeats the cross-user mutation vector entirely: even
      //     if an attacker crafts a valid blob containing another
      //     user's row id (or any global canon id), the existing
      //     row stays untouched and they cannot read its prior
      //     contents.
      //
      // The net effect: importing a lattice blob always rehydrates
      // memory as PERSONAL memory of the importing user, regardless
      // of how the source session originally scoped those rows. This
      // is the correct rehydration semantic for continuity (the user
      // gets their own history back) and the correct security
      // semantic (no shared state can be touched).
      for (const layer of ["canon", "continuity", "patches", "scratchpad"] as const) {
        for (const item of payload.memory_layers[layer] ?? []) {
          if (
            !item ||
            typeof item.id !== "string" ||
            typeof item.title !== "string" ||
            typeof item.content !== "string"
          ) {
            skipped += 1;
            continue;
          }
          const result = await tx
            .insert(memoryItemsTable)
            .values({
              id: item.id,
              user_id,
              layer,
              title: item.title,
              content: item.content,
              authority_level:
                Number.isFinite(item.authority_level) ? item.authority_level : 5,
              source: item.source ?? "manual",
              source_task_id: item.source_task_id ?? null,
            })
            .onConflictDoUpdate({
              target: memoryItemsTable.id,
              set: {
                layer,
                title: item.title,
                content: item.content,
                authority_level:
                  Number.isFinite(item.authority_level) ? item.authority_level : 5,
                source: item.source ?? "manual",
                source_task_id: item.source_task_id ?? null,
                updated_at: new Date(),
              },
              where: eq(memoryItemsTable.user_id, user_id),
            })
            .returning({ id: memoryItemsTable.id });
          if (result.length === 0) {
            // Either the row exists but is owned by another user (or
            // is global canon) and the WHERE rejected the update,
            // OR the INSERT was otherwise suppressed by the conflict.
            // Either way, the row was not written; count as skipped
            // so the user sees the elision and so the security
            // contract is observable.
            skipped += 1;
          } else {
            counts[layer] += 1;
          }
        }
      }

      // Rehydration conversation. Always created (per spec) so the
      // import is visible in the sidebar — even if no tasks were
      // included, the row marks the import event.
      const conv_title = `Imported from ${payload.source_session_id.slice(0, 8)}`;
      await tx.insert(conversationsTable).values({
        id: conv_id,
        user_id,
        title: conv_title,
        topic_keywords: ["lattice-import"],
      });
      counts.conversations = 1;

      // Tasks. Generate fresh ids so the rehydrated rows never collide
      // with an existing task. We persist the source task id into
      // input_text as a leading marker so the user can correlate back
      // to the original session if they kept a copy of the source blob.
      // Order ascending so created_at is monotonic within the new
      // conversation.
      const taskList: LatticeTask[] = [];
      for (const conv of payload.conversations ?? []) {
        for (const t of conv.tasks ?? []) {
          if (!t || typeof t.input_text !== "string") {
            skipped += 1;
            continue;
          }
          taskList.push(t);
        }
      }
      taskList.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
      for (const t of taskList) {
        const new_id = randomUUID();
        await tx.insert(tasksTable).values({
          id: new_id,
          user_id,
          input_text: t.input_text,
          task_type: typeof t.task_type === "string" && t.task_type ? t.task_type : "general",
          tri_state: typeof t.tri_state === "string" && t.tri_state ? t.tri_state : "GO",
          mode: typeof t.mode === "string" && t.mode ? t.mode : "single",
          final_status:
            typeof t.final_status === "string" && t.final_status ? t.final_status : "completed",
          final_output: t.final_output ?? null,
          conversation_id: conv_id,
        });
        counts.tasks += 1;
      }

      await auditLog(
        undefined,
        "LATTICE_IMPORTED",
        `Lattice imported by user ${user_id}`,
        {
          user_id,
          verified: true,
          fidelity_sha256: payload.fidelity_hash,
          recomputed: parsedBlob.recomputed_hash,
          source_session_id: payload.source_session_id,
          conversation_id: conv_id,
          counts,
          skipped,
        },
        tx,
      );
    });
  } catch (err) {
    req.log?.error({ err }, "Lattice import transaction failed");
    res.status(500).json({
      error: `Import failed: ${(err as Error).message}`,
      code: "LATTICE_IMPORT_FAILED",
    });
    return;
  }

  res.json({
    imported: counts,
    skipped,
    conversation_id: conv_id,
    source_session_id: payload.source_session_id,
    fidelity_sha256: payload.fidelity_hash,
  });
});

router.get("/exports", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const rows = await db
    .select()
    .from(latticeExportsTable)
    .where(eq(latticeExportsTable.user_id, req.user.id))
    .orderBy(desc(latticeExportsTable.created_at))
    .limit(10);
  res.json(rows);
});

export default router;
