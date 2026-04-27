import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare, MessageSquarePlus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Fidelity Lattice Continuity Protocol — Task #68 sidebar.
 *
 * Lists the current user's recent (non-archived) conversations and
 * surfaces the active one via the `?conversation=<id>` query param on
 * /console. Clicking "+ New" routes to /console without the param so
 * the next task submitted opens a fresh thread (the server-side
 * clusterer will then either auto-match or auto-create — TaskConsole
 * also forces a fresh thread on the next submit when the user came
 * here via "+ New chat").
 *
 * UX contract from the Task #68 spec:
 *   1. Section is collapsible (Conversations header toggles open/closed).
 *   2. Has a search input that hits GET /api/conversations?q=… so the
 *      list narrows to title matches as the user types.
 *   3. Each entry shows the title plus a relative "last active" stamp
 *      so the most recent thread is visually obvious.
 */

type ConversationRow = {
  id: string;
  user_id: string;
  title: string;
  topic_keywords: string[];
  created_at: string;
  last_active_at: string;
  archived: boolean;
};

async function fetchConversations(q: string): Promise<ConversationRow[]> {
  const params = new URLSearchParams({ archived: "false", limit: "50" });
  const trimmed = q.trim();
  if (trimmed) params.set("q", trimmed);
  const r = await fetch(`/api/conversations?${params.toString()}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) {
    if (r.status === 401) return [];
    throw new Error(`Failed to load conversations (${r.status})`);
  }
  const data = (await r.json()) as { conversations?: ConversationRow[] };
  return data.conversations ?? [];
}

function readActiveConversationId(search: string): string | null {
  try {
    const sp = new URLSearchParams(search);
    return sp.get("conversation");
  } catch {
    return null;
  }
}

/**
 * Format an ISO timestamp as a compact relative string ("3m", "2h",
 * "5d"). Stays under 4 characters so it fits next to the title even
 * in the narrow sidebar. Exported for the component test.
 */
export function formatRelativeTimestamp(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const deltaSec = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (deltaSec < 60) return "now";
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(day / 365)}y`;
}

export function ConversationsList() {
  const [location] = useLocation();
  const search = typeof window !== "undefined" ? window.location.search : "";
  // Re-derive active id whenever location changes — wouter doesn't expose
  // search-string changes, but a route change implies the URL was rebuilt
  // and the search above re-reads the live document.location.
  const activeId = useMemo(() => readActiveConversationId(search), [search, location]);

  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  // Debounce the query going to the server so each keystroke doesn't
  // refetch — but keep it simple/synchronous for tests. 200ms is short
  // enough to feel live in the sidebar.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useMemoizedDebounce(query, 200, setDebouncedQuery);

  const { data: conversations, isLoading, isError } = useQuery({
    queryKey: ["conversations", "sidebar", debouncedQuery],
    queryFn: () => fetchConversations(debouncedQuery),
    staleTime: 10_000,
    retry: false,
  });

  return (
    <div className="mb-4">
      <div className="px-5 mb-1.5 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70 font-semibold inline-flex items-center gap-1 hover:text-foreground"
          data-testid="button-toggle-conversations"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="w-3 h-3" strokeWidth={1.75} />
          ) : (
            <ChevronRight className="w-3 h-3" strokeWidth={1.75} />
          )}
          Conversations
        </button>
        {/* /console?new=1 arms the one-shot manual override on
            TaskConsole. Without it, "+ New" would only clear the
            URL param and the next submit would still get auto-
            clustered into whatever Jaccard-matches. */}
        <Link href="/console?new=1">
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
            data-testid="button-new-conversation"
            title="Start a new conversation (next message starts a fresh thread)"
          >
            <MessageSquarePlus className="w-3 h-3" strokeWidth={1.75} />
            New
          </button>
        </Link>
      </div>
      {open && (
        <>
          <div className="px-3 mb-1.5">
            <div className="relative">
              <Search
                className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/70"
                strokeWidth={1.75}
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search conversations…"
                className="w-full pl-6 pr-6 py-1 text-[11.5px] rounded-md border border-sidebar-border bg-sidebar-accent/30 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-accent"
                data-testid="input-conversation-search"
                aria-label="Search conversations"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground/70 hover:text-foreground"
                  data-testid="button-clear-conversation-search"
                  aria-label="Clear search"
                >
                  <X className="w-3 h-3" strokeWidth={1.75} />
                </button>
              )}
            </div>
          </div>
          {isLoading && (
            <div className="px-5 py-1 text-[11px] text-muted-foreground/70" data-testid="conversations-loading">
              Loading…
            </div>
          )}
          {isError && (
            <div className="px-5 py-1 text-[11px] text-red-700" data-testid="conversations-error">
              Failed to load conversations.
            </div>
          )}
          {!isLoading && !isError && (conversations?.length ?? 0) === 0 && (
            <div className="px-5 py-1 text-[11px] text-muted-foreground/70" data-testid="conversations-empty">
              {debouncedQuery ? "No matches." : "No conversations yet."}
            </div>
          )}
          <div className="max-h-64 overflow-y-auto">
            {conversations?.map((c) => {
              const active = activeId === c.id && (location === "/console" || location === "/");
              const stamp = formatRelativeTimestamp(c.last_active_at);
              return (
                <Link key={c.id} href={`/console?conversation=${encodeURIComponent(c.id)}`}>
                  <div
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 mx-2 rounded-md text-sm cursor-pointer transition-all duration-150",
                      active
                        ? "bg-card text-foreground shadow-card font-medium"
                        : "text-sidebar-foreground hover:bg-sidebar-accent",
                    )}
                    data-testid={`nav-conversation-${c.id}`}
                    title={c.title}
                  >
                    <MessageSquare
                      className={cn(
                        "w-3.5 h-3.5 flex-shrink-0",
                        active ? "text-accent" : "text-muted-foreground",
                      )}
                      strokeWidth={active ? 2.25 : 1.75}
                    />
                    <span className="text-[12.5px] truncate flex-1">{c.title}</span>
                    {stamp && (
                      <span
                        className="text-[10px] text-muted-foreground/70 tabular-nums flex-shrink-0"
                        data-testid={`text-conversation-stamp-${c.id}`}
                        title={new Date(c.last_active_at).toLocaleString()}
                      >
                        {stamp}
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Tiny inline debounce hook — pulled out of the component body so the
 * effect dependency array is obvious. Exists here (rather than in
 * @/hooks) because no other component currently needs it.
 */
function useMemoizedDebounce<T>(value: T, delayMs: number, setter: (v: T) => void) {
  useEffect(() => {
    const h = window.setTimeout(() => setter(value), delayMs);
    return () => window.clearTimeout(h);
  }, [value, delayMs, setter]);
}
