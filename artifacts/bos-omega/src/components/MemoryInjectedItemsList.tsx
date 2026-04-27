import { Link } from "wouter";
import { ExternalLink, AlertCircle } from "lucide-react";
import { useListMemory } from "@workspace/api-client-react";

// Per-item provenance recorded by the orchestrator on MEMORY_INJECTED.
// The shape mirrors what artifacts/api-server/src/bos/pipeline.ts persists
// in the audit row's `metadata.injected_items` array — id is the source
// memory_items.id at injection time, layer is the layer label, title is
// the row's display title at injection time.
export type InjectedItem = {
  id: string;
  layer: string;
  title: string;
};

const LAYER_COLORS: Record<string, string> = {
  CANON: "text-amber-700",
  CONTINUITY: "text-blue-700",
  PATCHES: "text-purple-700",
  SCRATCHPAD: "text-green-700",
};

// Strict runtime parser — defensively filters anything malformed so callers
// can pass `metadata.injected_items` straight from an audit row without
// pre-validating. Used by both MemoryUsedPanel (Task #50) and AuditLog
// (Task #56) so the two views always agree on what counts as an item.
export function parseInjectedItems(raw: unknown): InjectedItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (i): i is InjectedItem =>
      !!i &&
      typeof i === "object" &&
      typeof (i as InjectedItem).id === "string" &&
      typeof (i as InjectedItem).title === "string" &&
      typeof (i as InjectedItem).layer === "string",
  );
}

// Reusable items-list renderer extracted from MemoryUsedPanel so the same
// per-item provenance UI can be used on the global Audit Log page (Task #56)
// AND for the dropped-items list under the Task #51 notice (Task #58).
//
// Behaviour:
//   - Each entry shows the layer chip + clickable title that deep-links to
//     the source row in the Memory Manager (`/memory#item-<id>`).
//   - The component cross-references the supplied ids against the live
//     /api/memory list so rows deleted after the task ran are rendered as
//     "no longer available" instead of broken anchors. This is the same
//     cross-reference logic used for injected items, intentionally so that
//     a deleted-after-the-fact row reads identically whether it was used
//     or dropped.
//   - The cross-reference is gated on the `enabled` prop so callers that
//     render the list inside a collapsed panel can avoid the request until
//     the user actually expands it.
//   - When the cross-reference itself errors, links still render
//     optimistically (the Memory Manager just won't auto-scroll) and a
//     small inline notice flags that "no longer available" markers may
//     be missing for this view.
//   - `label` overrides the default "ITEMS INJECTED" header so the same
//     component can render both injected and dropped lists with their own
//     plain-English headings.
//   - `testIdPrefix` overrides the default `memory-injected` test-id stem
//     so unit tests targeting the dropped list don't collide with the
//     injected list rendered higher up in the same panel.
export function MemoryInjectedItemsList({
  items,
  enabled = true,
  label = "ITEMS INJECTED",
  testIdPrefix = "memory-injected",
}: {
  items: InjectedItem[];
  enabled?: boolean;
  label?: string;
  testIdPrefix?: string;
}) {
  const liveMemoryQuery = useListMemory({
    query: {
      queryKey: ["/api/memory"],
      enabled: enabled && items.length > 0,
      retry: false,
      staleTime: 60_000,
    },
  });
  const liveIds: Set<string> | null = liveMemoryQuery.data
    ? new Set(liveMemoryQuery.data.map((m) => m.id))
    : null;
  const liveLookupFailed =
    enabled && items.length > 0 && liveMemoryQuery.isError;

  if (items.length === 0) return null;

  return (
    <div>
      <div className="text-[10px] font-mono text-muted-foreground tracking-wider mb-2 flex items-center gap-2">
        <span>{label} ({items.length})</span>
        {liveLookupFailed && (
          <span
            className="not-italic text-amber-700 inline-flex items-center gap-1"
            data-testid={`${testIdPrefix}-lookup-failed`}
            title="Couldn't verify which items still exist; links may be stale"
          >
            <AlertCircle className="w-3 h-3" />
            couldn't verify items
          </span>
        )}
      </div>
      <ul className="space-y-1.5" data-testid={`${testIdPrefix}-items`}>
        {items.map((item, i) => {
          const layer_key = item.layer.toUpperCase();
          const color = LAYER_COLORS[layer_key] ?? "text-muted-foreground";
          // Three states for the cross-reference:
          //   - liveIds === null   → live list still loading (or errored).
          //     Render a link optimistically; the Memory Manager will simply
          //     not auto-scroll if the row is gone, which is acceptable
          //     degradation.
          //   - liveIds.has(id)    → row exists, link is safe.
          //   - !liveIds.has(id)   → row was deleted after the task ran.
          //     Render as plain "(no longer available)" text so we don't
          //     ship a broken anchor.
          const available = liveIds === null || liveIds.has(item.id);
          return (
            <li
              key={`${item.id}-${i}`}
              className="flex items-start gap-2 font-mono text-[11px] leading-snug"
              data-testid={`${testIdPrefix}-item-${item.id}`}
            >
              <span
                className={`shrink-0 w-[88px] uppercase tracking-wide ${color}`}
              >
                {layer_key}
              </span>
              {available ? (
                <Link
                  href={`/memory#item-${item.id}`}
                  className="text-primary hover:underline inline-flex items-center gap-1 break-all"
                  data-testid={`${testIdPrefix}-link-${item.id}`}
                >
                  <span>{item.title || "(untitled)"}</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </Link>
              ) : (
                <span
                  className="text-muted-foreground italic inline-flex items-center gap-1 break-all"
                  data-testid={`${testIdPrefix}-missing-${item.id}`}
                  title="The source memory row was deleted after this task ran"
                >
                  <AlertCircle className="w-3 h-3 shrink-0 text-amber-700" />
                  <span className="line-through">
                    {item.title || "(untitled)"}
                  </span>
                  <span className="not-italic text-[10px] text-amber-700">
                    no longer available
                  </span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
