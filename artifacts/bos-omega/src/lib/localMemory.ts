/**
 * Local Memory layer for BOS-OMEGA.
 *
 * Storage strategy:
 *   1. Primary:   IndexedDB ("bos-omega-local-memory" / store "items")
 *   2. Fallback:  localStorage key "bos.localMemory.items.v1"
 *
 * The localStorage fallback is used when IndexedDB is unavailable
 * (private windows, locked-down browsers, SSR), or when an IndexedDB
 * operation throws.
 *
 * Memory is shaped exactly like server memory items so it can later
 * be migrated to the canonical layer without re-modelling.
 */

export type LocalMemoryLayer =
  | "canon"
  | "patches"
  | "continuity"
  | "scratchpad";

export interface LocalMemoryItem {
  id: string;
  title: string;
  content: string;
  layer: LocalMemoryLayer;
  /** ISO 8601 */
  created_at: string;
  /** ISO 8601 */
  updated_at: string;
}

const DB_NAME = "bos-omega-local-memory";
const DB_VERSION = 1;
const STORE = "items";
const LS_KEY = "bos.localMemory.items.v1";

function lsRead(): LocalMemoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function lsWrite(items: LocalMemoryItem[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(items));
  } catch {
    // quota exceeded etc. — best-effort layer
  }
}

function idbAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbAll(): Promise<LocalMemoryItem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as LocalMemoryItem[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(item: LocalMemoryItem): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClear(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `lm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function listLocalMemory(): Promise<LocalMemoryItem[]> {
  if (idbAvailable()) {
    try {
      const items = await idbAll();
      // Most-recently-updated first.
      return [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    } catch {
      // fall through to localStorage
    }
  }
  const items = lsRead();
  return [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export interface CreateLocalMemoryInput {
  title: string;
  content: string;
  layer: LocalMemoryLayer;
}

export async function createLocalMemory(
  input: CreateLocalMemoryInput,
): Promise<LocalMemoryItem> {
  const now = new Date().toISOString();
  const item: LocalMemoryItem = {
    id: newId(),
    title: input.title.trim() || "(untitled)",
    content: input.content,
    layer: input.layer,
    created_at: now,
    updated_at: now,
  };

  if (idbAvailable()) {
    try {
      await idbPut(item);
      return item;
    } catch {
      // fall through
    }
  }
  const items = lsRead();
  items.push(item);
  lsWrite(items);
  return item;
}

export async function updateLocalMemory(
  id: string,
  patch: Partial<Omit<LocalMemoryItem, "id" | "created_at">>,
): Promise<LocalMemoryItem | null> {
  const all = await listLocalMemory();
  const existing = all.find((i) => i.id === id);
  if (!existing) return null;
  const updated: LocalMemoryItem = {
    ...existing,
    ...patch,
    id: existing.id,
    created_at: existing.created_at,
    updated_at: new Date().toISOString(),
  };

  if (idbAvailable()) {
    try {
      await idbPut(updated);
      return updated;
    } catch {
      // fall through
    }
  }
  const items = lsRead().map((i) => (i.id === id ? updated : i));
  lsWrite(items);
  return updated;
}

export async function deleteLocalMemory(id: string): Promise<void> {
  if (idbAvailable()) {
    try {
      await idbDelete(id);
      return;
    } catch {
      // fall through
    }
  }
  lsWrite(lsRead().filter((i) => i.id !== id));
}

export async function clearLocalMemory(): Promise<void> {
  if (idbAvailable()) {
    try {
      await idbClear();
      return;
    } catch {
      // fall through
    }
  }
  lsWrite([]);
}

export interface LocalMemoryExport {
  format: "bos-omega.local-memory.v1";
  exported_at: string;
  items: LocalMemoryItem[];
}

export async function exportLocalMemory(): Promise<LocalMemoryExport> {
  const items = await listLocalMemory();
  return {
    format: "bos-omega.local-memory.v1",
    exported_at: new Date().toISOString(),
    items,
  };
}

/**
 * Imports an export bundle. By default merges (replacing items with the
 * same id); pass `replace: true` to clear first.
 */
export async function importLocalMemory(
  bundle: unknown,
  opts: { replace?: boolean } = {},
): Promise<{ imported: number }> {
  const incoming = parseImportBundle(bundle);
  if (incoming.length === 0) return { imported: 0 };

  if (opts.replace) {
    await clearLocalMemory();
  }

  let imported = 0;
  if (idbAvailable()) {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const item of incoming) store.put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      imported = incoming.length;
      return { imported };
    } catch {
      // fall through to localStorage
    }
  }

  const merged = new Map<string, LocalMemoryItem>();
  for (const i of lsRead()) merged.set(i.id, i);
  for (const i of incoming) merged.set(i.id, i);
  lsWrite([...merged.values()]);
  imported = incoming.length;
  return { imported };
}

function parseImportBundle(bundle: unknown): LocalMemoryItem[] {
  if (!bundle || typeof bundle !== "object") return [];
  const obj = bundle as Record<string, unknown>;
  const items = Array.isArray(obj["items"]) ? (obj["items"] as unknown[]) : [];
  const out: LocalMemoryItem[] = [];
  const valid_layers: LocalMemoryLayer[] = ["canon", "patches", "continuity", "scratchpad"];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const layer = r["layer"];
    if (typeof r["title"] !== "string" || typeof r["content"] !== "string") continue;
    if (typeof layer !== "string" || !valid_layers.includes(layer as LocalMemoryLayer)) continue;
    const now = new Date().toISOString();
    out.push({
      id: typeof r["id"] === "string" ? (r["id"] as string) : newId(),
      title: r["title"] as string,
      content: r["content"] as string,
      layer: layer as LocalMemoryLayer,
      created_at: typeof r["created_at"] === "string" ? (r["created_at"] as string) : now,
      updated_at: typeof r["updated_at"] === "string" ? (r["updated_at"] as string) : now,
    });
  }
  return out;
}

/**
 * Build a memory_context block from local memory, ranked by layer
 * authority + recency, capped to a token-equivalent character budget.
 *
 * This is injected BELOW canon/patches in the prompt — server-side
 * canon always wins. Local memory is treated as user "scratchpad"
 * with elevated visibility.
 */
const APPROX_CHARS_PER_TOKEN = 4;

const LAYER_RANK: Record<LocalMemoryLayer, number> = {
  canon: 4,
  patches: 3,
  continuity: 2,
  scratchpad: 1,
};

export async function buildLocalMemoryInjection(
  task_input: string,
  budget_tokens: number = 500,
): Promise<string> {
  const items = await listLocalMemory();
  if (items.length === 0) return "";

  const ranked = [...items].sort((a, b) => {
    const lr = LAYER_RANK[b.layer] - LAYER_RANK[a.layer];
    if (lr !== 0) return lr;
    return b.updated_at.localeCompare(a.updated_at);
  });

  const budget_chars = budget_tokens * APPROX_CHARS_PER_TOKEN;
  const selected: LocalMemoryItem[] = [];
  let used = 0;
  for (const item of ranked) {
    const cost = item.title.length + item.content.length + 12;
    if (used + cost > budget_chars) continue;
    selected.push(item);
    used += cost;
  }
  if (selected.length === 0) return "";

  // Use task_input only to log a hint; ranking by relevance can be a future
  // enhancement. For now layer + recency is honest about budget use.
  void task_input;

  const lines = selected.map(
    (i) => `- [${i.layer.toUpperCase()}] ${i.title}: ${i.content}`,
  );
  return `=== LOCAL USER MEMORY (browser-stored, lower authority than server canon) ===\n${lines.join("\n")}`;
}
