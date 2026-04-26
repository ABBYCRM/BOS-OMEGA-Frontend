import { db } from "@workspace/db";
import { memoryItemsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

export async function getCanonMemory(user_id?: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(memoryItemsTable)
    .where(eq(memoryItemsTable.layer, "canon"))
    .orderBy(desc(memoryItemsTable.authority_level))
    .limit(10);
  return rows.map((r) => `[CANON:${r.title}] ${r.content}`);
}

export async function getScratchpad(user_id?: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(memoryItemsTable)
    .where(eq(memoryItemsTable.layer, "scratchpad"))
    .orderBy(desc(memoryItemsTable.updated_at))
    .limit(5);
  return rows.map((r) => `[SCRATCHPAD:${r.title}] ${r.content}`);
}

export function buildContextFromMemory(canon: string[], scratchpad: string[]): string {
  if (canon.length === 0 && scratchpad.length === 0) return "";
  const parts: string[] = [];
  if (canon.length > 0) parts.push("=== CANON CONTEXT ===\n" + canon.join("\n"));
  if (scratchpad.length > 0) parts.push("=== SCRATCHPAD ===\n" + scratchpad.join("\n"));
  return parts.join("\n\n");
}
