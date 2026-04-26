import { useState } from "react";
import { useListTasks } from "@workspace/api-client-react";
import { Link } from "wouter";
import { TriStateBadge, TaskStatusBadge } from "@/components/StatusBadge";
import { formatDate, formatMs, truncate } from "@/lib/utils";
import { List, ChevronLeft, ChevronRight } from "lucide-react";

export function TaskLogs() {
  const [page, setPage] = useState(0);
  const limit = 20;
  const { data, isLoading } = useListTasks({ limit, offset: page * limit });

  const tasks = data?.tasks || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <List className="w-4 h-4 text-primary" />
          <h1 className="text-xl font-serif font-semibold text-foreground tracking-tight">Task logs</h1>
          <span className="text-[11px] font-mono text-muted-foreground">({total} total)</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            disabled={page === 0}
            onClick={() => setPage(p => p - 1)}
            className="p-1.5 border border-border rounded text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-3 h-3" />
          </button>
          <span className="text-[11px] font-mono text-muted-foreground">
            {page + 1} / {Math.max(1, totalPages)}
          </span>
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage(p => p + 1)}
            className="p-1.5 border border-border rounded text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>
      </div>

      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border">
              {["TASK ID", "INPUT", "TYPE", "TRI-STATE", "PROVIDER/MODEL", "STATUS", "MODE", "CREATED"].map((h) => (
                <th key={h} className="px-3 py-2.5 text-left text-[10px] text-muted-foreground tracking-wider font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={8} className="px-3 py-8 text-muted-foreground text-center">Loading tasks...</td></tr>
            ) : tasks.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-8 text-muted-foreground text-center">No tasks yet. Submit one from the Task Console.</td></tr>
            ) : (
              tasks.map((t) => (
                <tr key={t.id} className="border-b border-border/50 hover:bg-secondary transition-colors cursor-pointer group">
                  <td className="px-3 py-2.5">
                    <Link href={`/tasks/${t.id}`}>
                      <span className="text-primary hover:underline text-[11px]">{t.id.slice(0, 8)}...</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-foreground max-w-xs">
                    <Link href={`/tasks/${t.id}`}>
                      <span className="group-hover:text-primary transition-colors">{truncate(t.input_text, 60)}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="px-1.5 py-0.5 bg-muted/40 border border-border rounded text-[10px] text-muted-foreground">{t.task_type}</span>
                  </td>
                  <td className="px-3 py-2.5"><TriStateBadge state={t.tri_state} /></td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {t.selected_provider ? `${t.selected_provider}/${t.selected_model}` : "—"}
                  </td>
                  <td className="px-3 py-2.5"><TaskStatusBadge status={t.final_status} /></td>
                  <td className="px-3 py-2.5">
                    <span className="text-[10px] text-muted-foreground">{t.mode || "single"}</span>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground text-[10px]">{formatDate(t.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
