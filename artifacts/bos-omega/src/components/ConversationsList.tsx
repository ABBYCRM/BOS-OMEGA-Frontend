import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { useMemo } from "react";
import { MessageSquare, MessageSquarePlus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Fidelity Lattice Continuity Protocol — Task #68 sidebar.
 *
 * Lists the current user's recent (non-archived) conversations and
 * surfaces the active one via the `?conversation=<id>` query param on
 * /console. Clicking "+ New" routes to /console without the param so
 * the next task submitted opens a fresh thread (the server-side
 * clusterer will then either auto-match or auto-create).
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

async function fetchConversations(): Promise<ConversationRow[]> {
  const r = await fetch("/api/conversations?archived=false&limit=50", {
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

export function ConversationsList() {
  const [location] = useLocation();
  const search = typeof window !== "undefined" ? window.location.search : "";
  // Re-derive active id whenever location changes — wouter doesn't expose
  // search-string changes, but a route change implies the URL was rebuilt
  // and the search above re-reads the live document.location.
  const activeId = useMemo(() => readActiveConversationId(search), [search, location]);

  const { data: conversations, isLoading, isError } = useQuery({
    queryKey: ["conversations", "sidebar"],
    queryFn: fetchConversations,
    staleTime: 10_000,
    retry: false,
  });

  return (
    <div className="mb-4">
      <div className="px-5 mb-1.5 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70 font-semibold">
          Conversations
        </span>
        <Link href="/console">
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
            data-testid="button-new-conversation"
            title="Start a new conversation"
          >
            <MessageSquarePlus className="w-3 h-3" strokeWidth={1.75} />
            New
          </button>
        </Link>
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
          No conversations yet.
        </div>
      )}
      <div className="max-h-64 overflow-y-auto">
        {conversations?.map((c) => {
          const active = activeId === c.id && (location === "/console" || location === "/");
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
                <span className="text-[12.5px] truncate">{c.title}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
