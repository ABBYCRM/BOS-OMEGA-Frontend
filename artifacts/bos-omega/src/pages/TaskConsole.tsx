import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCreateTask, useGetTaskStats } from "@workspace/api-client-react";
import type { BosOutput } from "@workspace/api-client-react";
import { Composer } from "@/components/Composer";
import { MessageList, type ChatMessage, type AssistantMessage } from "@/components/MessageList";
import { PersonaEditor } from "@/components/PersonaEditor";
import { ScratchpadPanel } from "@/components/ScratchpadPanel";
import {
  CopyContinuityBundle,
  RehydrateBundleModal,
} from "@/components/ContinuityBundleControls";
import type { UploadedAttachment } from "@/lib/uploads";
import { formatMs } from "@/lib/utils";
import { buildLocalMemoryInjection } from "@/lib/localMemory";
import { usePersonas, type PersonaSlotKey, type PersonaSlotView } from "@/lib/personas";
import {
  Send, Loader2, Layers, GitMerge, Vote, Zap, Flame, AlertTriangle,
  CheckCircle2, ChevronRight, MessageSquarePlus, Scale, Code2, ShieldAlert, X,
  ShieldCheck, FileSearch, GitPullRequest, Wrench, Settings2,
  ClipboardPaste,
} from "lucide-react";

// BOP.FRONT_DOOR.v1 — first-run prompt cards. These mirror the four
// canonical task shapes BOS-OMEGA handles best (vendor risk, contract
// review, code review, build plan) and seed the input on click.
const FRONT_DOOR_PROMPTS: Array<{
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  desc: string;
  prompt: string;
  accent: string;
}> = [
  {
    key: "vendor-risk",
    icon: ShieldCheck,
    label: "Vendor risk",
    desc: "Should we approve this vendor?",
    prompt:
      "Should we approve this vendor? Vendor: [name]. Service: [what they do]. Scope: [what data/access]. Constraints: [budget, timeline, regulatory]. Give a GO/HOLD/ABORT with risk drivers and mitigations.",
    accent: "border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50",
  },
  {
    key: "contract-review",
    icon: FileSearch,
    label: "Contract review",
    desc: "Is this contract safe to sign?",
    prompt:
      "Review this contract for risk before we sign. Counterparty: [name]. Term length: [duration]. Key clauses to watch: liability cap, IP assignment, termination, indemnity, data handling. Flag every clause that's worse than market and propose a redline.",
    accent: "border-amber-200 bg-amber-50/40 hover:bg-amber-50",
  },
  {
    key: "code-review",
    icon: GitPullRequest,
    label: "Code review",
    desc: "Review this PR for risk.",
    prompt:
      "Review this pull request before merge. Goal of the change: [what it does]. Risk surface: [auth/data/payments/etc]. Check for: correctness, security, performance, observability, test coverage, and rollback safety. Give a GO/HOLD/ABORT with concrete blocking items.",
    accent: "border-blue-200 bg-blue-50/40 hover:bg-blue-50",
  },
  {
    key: "build-plan",
    icon: Wrench,
    label: "Build plan",
    desc: "Plan a step-by-step fix.",
    prompt:
      "Build a step-by-step plan to fix this workflow. Symptom: [what is broken]. Last working state: [when]. Recent changes: [what changed]. Constraints: [downtime tolerance, blast radius]. Produce a sequenced plan with diagnostics, fix steps, validation, and rollback.",
    accent: "border-violet-200 bg-violet-50/40 hover:bg-violet-50",
  },
];

type Mode = "auto" | "single" | "parallel" | "consensus" | "series_pass" | "boil_the_ocean";

// BOP.PERSONA_SLOTS.v1 — three editable persona slots whose title/content
// live as canon-style memory rows on the server. The UI here is purely
// presentational (icon + accent colour); the persona text the model sees
// comes from the server-side row resolved at pipeline time.
// BOP.PERSONA_SLOTS.v1 — three editable persona slots whose title/content
// live as canon-style memory rows on the server. The UI here is purely
// presentational (icon + accent colour); the persona text the model sees
// comes from the server-side row resolved at pipeline time.
//
// 2026-08-09: bumped LS key to v2 so existing browsers that have a stale
// "A" (Legal Counsel) selection from a prior session drop back to the
// default (null = no persona). The persona is still selectable from the
// UI; this just resets the "stuck on Legal Counsel from two days ago"
// case where every task got a legal-memo skeleton regardless of input.
const PERSONA_LS_KEY = "bos.persona_slot.v2";

type PersonaPresentation = {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  activeColor: string;
};

const PERSONA_PRESENTATION: Record<PersonaSlotKey, PersonaPresentation> = {
  A: {
    icon: Scale,
    color: "border-amber-200 bg-amber-50/40 hover:bg-amber-50",
    activeColor: "bg-amber-100 border-amber-400 ring-2 ring-amber-300/40",
  },
  B: {
    icon: Code2,
    color: "border-blue-200 bg-blue-50/40 hover:bg-blue-50",
    activeColor: "bg-blue-100 border-blue-400 ring-2 ring-blue-300/40",
  },
  C: {
    icon: ShieldAlert,
    color: "border-red-200 bg-red-50/40 hover:bg-red-50",
    activeColor: "bg-red-100 border-red-400 ring-2 ring-red-300/40",
  },
};

function readStoredPersonaSlot(): PersonaSlotKey | null {
  if (typeof window === "undefined") return null;
  try {
    // 2026-08-09: check the new key first, then fall back to the old
    // v1 key (which had "A" hardcoded as the default for fresh browsers
    // and which many operators never changed away from). When we read
    // from the old key we migrate the value forward and delete the
    // old key, so this migration only runs once per browser.
    const newRaw = window.localStorage.getItem(PERSONA_LS_KEY);
    if (newRaw === "A" || newRaw === "B" || newRaw === "C") return newRaw;
    const oldRaw = window.localStorage.getItem("bos.persona_slot.v1");
    if (oldRaw === "A" || oldRaw === "B" || oldRaw === "C") {
      // Migrate: write the v2 key, delete the v1 key.
      window.localStorage.setItem(PERSONA_LS_KEY, oldRaw);
      window.localStorage.removeItem("bos.persona_slot.v1");
      // ...but if the operator's stuck-on-A is forcing a legal memo
      // on every task, the right thing is to drop the persona entirely
      // so the new kernel (no false-positive refusals) takes effect.
      // 2026-08-09: do NOT migrate 'A' — clear it instead so casual
      // chat stops being routed through the legal lens.
      if (oldRaw === "A") {
        window.localStorage.removeItem(PERSONA_LS_KEY);
        return null;
      }
      return oldRaw;
    }
  } catch {
    // ignore
  }
  return null;
}

function writeStoredPersonaSlot(p: PersonaSlotKey | null): void {
  if (typeof window === "undefined") return;
  try {
    if (p === null) {
      window.localStorage.removeItem(PERSONA_LS_KEY);
      // Also clear the legacy v1 key so a future migration from another
      // device doesn't resurrect the stuck-on-A state.
      window.localStorage.removeItem("bos.persona_slot.v1");
    } else {
      window.localStorage.setItem(PERSONA_LS_KEY, p);
    }
  } catch {
    // ignore
  }
}

// First non-blank line of the persona content, used as a one-line tooltip /
// description under the slot's title on the persona button.
function personaSummary(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length > 0) return t.length > 140 ? `${t.slice(0, 137)}…` : t;
  }
  return "Click to edit this persona's instruction.";
}

type ModeOption = {
  value: Mode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  desc: string;
  badge?: string;
  badgeColor?: string;
  cost?: "low" | "medium" | "high" | "extreme";
};

const MODE_OPTIONS: ModeOption[] = [
  { value: "auto",           label: "Auto",            icon: Zap,          desc: "Selects the best execution mode based on task complexity", badge: "Recommended", badgeColor: "bg-orange-50 text-orange-800 border-orange-200", cost: "medium" },
  { value: "single",         label: "Single",          icon: Layers,       desc: "One best-fit model chosen by the router", cost: "low" },
  { value: "parallel",       label: "Parallel",        icon: GitMerge,     desc: "Multiple models run concurrently, answers merged", cost: "medium" },
  { value: "consensus",      label: "Consensus",       icon: Vote,         desc: "Majority vote across models for reliability", cost: "medium" },
  { value: "series_pass",    label: "Series pass",     icon: ChevronRight, desc: "Drafter → Critic → Expander → Adversary → Synthesizer", badge: "5-role chain", badgeColor: "bg-violet-50 text-violet-800 border-violet-200", cost: "high" },
  { value: "boil_the_ocean", label: "Boil the ocean",  icon: Flame,        desc: "All models × 5 agents + synthesis + adversarial + Omega", badge: "Maximum power", badgeColor: "bg-red-50 text-red-800 border-red-200", cost: "extreme" },
];

const COST_LABEL: Record<string, { label: string; color: string }> = {
  low:     { label: "Low cost",     color: "text-green-700 bg-green-50 border-green-200" },
  medium:  { label: "Medium cost",  color: "text-amber-800 bg-amber-50 border-amber-200" },
  high:    { label: "High cost",    color: "text-orange-800 bg-orange-50 border-orange-200" },
  extreme: { label: "Extreme cost", color: "text-red-800 bg-red-50 border-red-200" },
};

let MSG_SEQ = 0;
const newMsgId = () => `m-${Date.now()}-${++MSG_SEQ}`;

// Task #57: Task Detail's "Active persona" panel deep-links to a specific
// slot via `/console#persona-slot-A` (or B/C). We parse that hash here so
// the console can scroll to the persona section AND auto-open the editor
// for the matching slot. Reading window.location.hash directly is
// intentional — wouter's path-based router doesn't track hash.
function readPersonaSlotHash(): PersonaSlotKey | null {
  if (typeof window === "undefined") return null;
  const m = /^#persona-slot-([ABC])$/.exec(window.location.hash);
  if (!m) return null;
  const s = m[1];
  return s === "A" || s === "B" || s === "C" ? s : null;
}

// Lattice continuity (Task #68): conversation scoping comes through
// /console?conversation=<id>. The sidebar emits these links, the server
// clusterer pins each new task to that thread, and the page rehydrates
// historical messages from the conversation row's task list on mount.
function readActiveConversationId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const sp = new URLSearchParams(window.location.search);
    const v = sp.get("conversation");
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// Task #64 — Resume support for orphan and pre-cluster tasks. The
// TaskLogs / TaskDetail Resume buttons emit `/console?task=<id>` for
// any row that lacks a conversation_id, OR as a defensive fallback
// for rows the sidebar can't yet group. We accept the param here,
// fetch the task once, and either: (a) rewrite the URL to
// `?conversation=<task.conversation_id>` so the existing rehydrate
// flow takes over (the common case — the clusterer almost always
// pins tasks to a conversation eventually), or (b) hydrate the
// solitary task as a single-turn "imported" message so the user
// can continue from it even when no conversation exists.
function readResumeTaskId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const sp = new URLSearchParams(window.location.search);
    const v = sp.get("task");
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

interface ResumeTaskRow {
  id: string;
  conversation_id: string | null;
  input_text: string;
  final_output: string | null;
  task_type: string | null;
  tri_state: string | null;
  final_status: string | null;
  created_at: string;
}

async function fetchResumeTask(id: string): Promise<ResumeTaskRow> {
  const r = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { credentials: "include" });
  if (!r.ok) throw new Error(`fetchResumeTask failed: ${r.status}`);
  const data = await r.json();
  // The /api/tasks/:id endpoint returns either { task: {...} } or the
  // task row directly depending on which version the artifact runs.
  // Accept both shapes so this resume path is resilient to either.
  const t = (data?.task ?? data) as ResumeTaskRow;
  return t;
}

type ConversationDetail = {
  conversation: {
    id: string;
    title: string;
    archived: boolean;
  };
  tasks: Array<{
    id: string;
    input_text: string;
    tri_state: string;
    task_type: string;
    final_status: string;
    // Task #64 — present so resumed conversations can show the
    // assistant's prior answer (parsed into bos_output) in
    // MessageList instead of an empty assistant bubble.
    final_output: string | null;
    created_at: string;
  }>;
};

async function fetchConversationDetail(id: string): Promise<ConversationDetail> {
  const r = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Failed to load conversation (${r.status})`);
  return (await r.json()) as ConversationDetail;
}

// Re-hydrate a conversation's stored tasks into the chat-thread shape
// the MessageList expects. Task #64: parse `final_output` (a JSON
// envelope produced by the pipeline) into `bos_output` so the
// AssistantBubble shows the prior answer text — without this the
// resumed thread looks empty even though the data is there. If the
// envelope is malformed (legacy rows / partial writes) we fall back
// to surfacing the raw string under `final_output` so the user is
// never silently shown a blank bubble.
function conversationToMessages(detail: ConversationDetail): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const t of detail.tasks) {
    out.push({
      id: `u-${t.id}`,
      role: "user",
      text: t.input_text,
      attachments: [],
      ts: new Date(t.created_at).getTime(),
    });
    // Prefer the parsed pipeline envelope so AssistantBubble shows
    // the rich answer text + assumptions/uncertainties. If the row
    // is legacy or partially-written and the JSON envelope is
    // malformed, synthesize a minimal BosOutput pointing the
    // `answer` field at the raw stored text — without this fallback
    // MessageList renders "No answer text returned." even though
    // the underlying string is non-empty, which is exactly the
    // "blank assistant bubble" regression the resume-fidelity work
    // was meant to eliminate.
    let bos_output: BosOutput | undefined;
    if (t.final_output) {
      try {
        bos_output = JSON.parse(t.final_output) as BosOutput;
      } catch {
        bos_output = {
          state: (t.tri_state === "GO" || t.tri_state === "HOLD" || t.tri_state === "ABORT")
            ? (t.tri_state as BosOutput["state"])
            : "GO",
          task_type: t.task_type || "general",
          answer: t.final_output,
          assumptions: [],
          uncertainties: [],
          missing_inputs: [],
          failure_modes: [],
        };
      }
    }
    out.push({
      id: `a-${t.id}`,
      role: "assistant",
      status: "done",
      mode: "auto",
      task: {
        task_id: t.id,
        task_type: t.task_type,
        tri_state: t.tri_state,
        final_status: t.final_status,
        final_output: t.final_output ?? undefined,
        bos_output,
      },
      ts: new Date(t.created_at).getTime() + 1,
    });
  }
  return out;
}

export function TaskConsole() {
  const [location] = useLocation();
  // wouter's useLocation only tracks pathname; subscribe to the search
  // string separately so navigating /console → /console?conversation=<id>
  // (sidebar click) and back actually re-runs the activeConversationId
  // memo and triggers the rehydrate effect below.
  const search = useSearch();
  const qc = useQueryClient();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const [persona_slot, setPersonaSlotState] = useState<PersonaSlotKey | null>(() => readStoredPersonaSlot());
  const [editing_slot, setEditingSlot] = useState<PersonaSlotView | null>(null);
  const { slots: persona_slots, is_loading: persona_slots_loading } = usePersonas();
  const [parallelCount, setParallelCount] = useState(3);
  const [maxModels, setMaxModels] = useState(3);
  const [agentsPerModel, setAgentsPerModel] = useState(5);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [resetSignal, setResetSignal] = useState(0);

  // Task #84 — "Edit this" affordance on generated images dispatches a
  // `bos:edit-image` window event from MessageList.tsx. We catch it here,
  // prefill the composer with a starter edit prompt, and scroll the
  // composer into focus so the user only has to type the desired change
  // ("…to be in pastel colors") and press Send. The pipeline-side intent
  // detector recognizes the leading "Edit this image" phrasing and the
  // most-recent generated_attachment lookup will pick up the right parent.
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ attachment_id: string; original_name: string }>).detail;
      if (!detail) return;
      setInput((prev) => {
        const stub = "Edit this image to ";
        // Don't clobber user-typed text — only prefill when the composer
        // is empty (or already starts with the same stub from a prior
        // click) so consecutive clicks are idempotent.
        if (!prev || prev.startsWith(stub)) return stub;
        return prev;
      });
      // Defer focus to next tick so the textarea has the new value.
      requestAnimationFrame(() => {
        const ta = document.querySelector<HTMLTextAreaElement>("textarea[placeholder]");
        if (ta) {
          ta.focus();
          const len = ta.value.length;
          ta.setSelectionRange(len, len);
        }
      });
    }
    window.addEventListener("bos:edit-image", handler as EventListener);
    return () => window.removeEventListener("bos:edit-image", handler as EventListener);
  }, []);

  // Task #86 — "Regenerate" affordance on a generated image fires
  // `bos:regenerate-image` with the original prompt. We submit it as a
  // brand-new task (idempotent — no mutation of the prior assistant
  // message's bos_output) so the user gets a fresh roll of the dice
  // with the same intent. The submit goes through the standard
  // submitTask path so all the conversation-routing, persona-slot, and
  // local-memory injection logic stays consistent with a hand-typed
  // submit. We use a ref-bound latest-handler pattern so the listener
  // doesn't have to re-bind on every state change of submitTask's
  // closure dependencies.
  const regenerateHandlerRef = useRef<(prompt: string) => void>(() => {});
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ prompt: string }>).detail;
      if (!detail?.prompt) return;
      regenerateHandlerRef.current(detail.prompt);
    }
    window.addEventListener("bos:regenerate-image", handler as EventListener);
    return () => window.removeEventListener("bos:regenerate-image", handler as EventListener);
  }, []);

  // Re-derive the active conversation id whenever EITHER the pathname
  // or the search string changes (sidebar nav rewrites only the search
  // string, "+ New" rewrites both). The memo keys off both so we don't
  // miss query-only navigations.
  const activeConversationId = useMemo<string | null>(
    () => readActiveConversationId(),
    [location, search],
  );

  // Resume-by-task: when /console?task=<id> is in the URL but
  // /console?conversation=<id> is not, look up the task once and
  // either rewrite the URL to ?conversation=<id> (so the existing
  // rehydrate flow takes over) or fall back to seeding the input
  // box with the task's prompt for true orphan tasks.
  const resumeTaskId = useMemo<string | null>(
    () => (activeConversationId ? null : readResumeTaskId()),
    [activeConversationId, location, search],
  );
  const resumeHandled = useRef<string | null>(null);
  useEffect(() => {
    if (!resumeTaskId || resumeHandled.current === resumeTaskId) return;
    resumeHandled.current = resumeTaskId;
    let cancelled = false;
    (async () => {
      try {
        const t = await fetchResumeTask(resumeTaskId);
        if (cancelled) return;
        if (t.conversation_id) {
          // Common case: the task is part of a conversation. Hand off
          // to the existing conversation rehydrate flow by rewriting
          // the URL — replaceState so the user's back button still
          // returns to TaskLogs.
          const next = `/console?conversation=${encodeURIComponent(t.conversation_id)}`;
          window.history.replaceState(null, "", next);
          // Force the wouter location to recompute.
          window.dispatchEvent(new PopStateEvent("popstate"));
        } else {
          // Orphan task — seed the chat with the prior turn so the
          // user can continue the thread inline. We render the prior
          // user input as a user bubble and the prior task as an
          // assistant bubble, then leave the input box empty so the
          // user can type the next message.
          const seedTs = new Date(t.created_at).getTime();
          // Parse final_output → bos_output the same way
          // conversationToMessages does, so AssistantBubble shows the
          // prior answer text on the orphan-task resume path. Without
          // this MessageList renders "No answer text returned." even
          // though the underlying string is non-empty, defeating the
          // whole point of Resume.
          let bos_output: BosOutput | undefined;
          if (t.final_output) {
            try {
              bos_output = JSON.parse(t.final_output) as BosOutput;
            } catch {
              const triState = t.tri_state === "GO" || t.tri_state === "HOLD" || t.tri_state === "ABORT"
                ? (t.tri_state as BosOutput["state"])
                : "GO";
              bos_output = {
                state: triState,
                task_type: t.task_type ?? "general",
                answer: t.final_output,
                assumptions: [],
                uncertainties: [],
                missing_inputs: [],
                failure_modes: [],
              };
            }
          }
          const seeded: ChatMessage[] = [
            {
              id: `u-${t.id}`,
              role: "user",
              text: t.input_text,
              attachments: [],
              ts: seedTs,
            },
            {
              id: `a-${t.id}`,
              role: "assistant",
              status: "done",
              mode: "auto",
              task: {
                task_id: t.id,
                task_type: t.task_type ?? "general",
                tri_state: t.tri_state ?? "GO",
                final_status: t.final_status ?? "COMPLETED",
                final_output: t.final_output ?? undefined,
                bos_output,
              },
              ts: seedTs + 1,
            },
          ];
          setMessages(seeded);
        }
      } catch (err) {
        // Surface the error as a synthetic assistant bubble so the
        // user sees why Resume didn't open the task.
        const msg = err instanceof Error ? err.message : String(err);
        const ts = Date.now();
        setMessages([
          {
            id: `a-resume-error-${resumeTaskId}`,
            role: "assistant",
            status: "error",
            mode: "auto",
            error: `Could not resume task ${resumeTaskId}: ${msg}`,
            ts,
          },
        ]);
      }
    })();
    return () => { cancelled = true; };
  }, [resumeTaskId]);

  const { data: conversationDetail } = useQuery({
    queryKey: ["conversation-detail", activeConversationId],
    queryFn: () => fetchConversationDetail(activeConversationId!),
    enabled: !!activeConversationId,
    staleTime: 10_000,
    retry: false,
  });

  // When the active conversation CHANGES, replace the in-memory thread
  // with the server-side history exactly once. After that we keep the
  // thread mutable so optimistic user/assistant entries don't get
  // clobbered by an incidental conversationDetail refetch (focus,
  // staleness, post-mutation invalidation). The ref tracks which
  // conversation id we've already rehydrated for.
  //
  // Switching to a different conversation must clear the in-memory
  // thread immediately so a slow detail fetch can't show last
  // conversation's messages briefly. Switching to "no conversation"
  // (e.g. clicking "New chat") also clears.
  const hydratedFor = useRef<string | null>(null);
  useEffect(() => {
    if (activeConversationId !== hydratedFor.current) {
      // Different conversation (or unscoped). Drop stale state up
      // front; we'll repopulate when conversationDetail arrives.
      setMessages([]);
      hydratedFor.current = activeConversationId;
    }
    if (activeConversationId && conversationDetail
        && conversationDetail.conversation.id === activeConversationId
        && hydratedFor.current === activeConversationId) {
      // Only hydrate if we haven't already loaded messages for this
      // conversation in this mount. Optimistic appends from submitTask
      // bring the thread back > 0 entries; once that happens we won't
      // re-overwrite. Initial load (messages.length === 0) is the only
      // moment we materialize server history into the chat thread.
      setMessages((prev) => prev.length === 0
        ? conversationToMessages(conversationDetail)
        : prev);
    }
  }, [activeConversationId, conversationDetail]);

  const createTask = useCreateTask();
  const { data: stats } = useGetTaskStats();

  // One-shot manual override for the conversation clusterer. When the
  // user clicks "+ New chat" we set this to true; the next submit
  // sends `force_new_conversation: true` to POST /api/tasks (so the
  // server's heuristic is bypassed and a fresh thread is created even
  // if the input would otherwise Jaccard-match an existing one), and
  // then we consume the flag. This is the user-facing escape hatch
  // when the auto-clusterer puts something in the wrong place.
  const [forceNewConversation, setForceNewConversation] = useState(false);

  // Task #64: continuity bundle state. `rehydrateOpen` controls the
  // paste-and-import modal. `currentTaskId` tracks the most recent
  // assistant turn whose task succeeded — that's the natural scope
  // for the "Copy bundle" button when there is no active conversation
  // (e.g. user just ran a one-off task without picking a thread). A
  // monotonically increasing `scratchpadRefetchKey` is bumped each
  // time a task completes so the live ScratchpadPanel below the
  // thread re-fetches and shows the freshly written auto-summary.
  const [rehydrateOpen, setRehydrateOpen] = useState(false);
  const [scratchpadRefetchKey, setScratchpadRefetchKey] = useState(0);
  const currentTaskId = useMemo<string | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "assistant" && m.task?.task_id) return m.task.task_id;
    }
    return null;
  }, [messages]);

  // The sidebar's "+ New" link routes to /console?new=1 to arm the
  // override from outside this component. Consume that flag once the
  // page mounts (or the search string changes), then strip it from
  // the URL so a hard refresh doesn't re-arm it.
  useEffect(() => {
    const sp = new URLSearchParams(search);
    if (sp.get("new") === "1") {
      setForceNewConversation(true);
      sp.delete("new");
      const next = sp.toString();
      window.history.replaceState({}, "", next ? `/console?${next}` : "/console");
    }
  }, [search]);

  function setPersonaSlot(p: PersonaSlotKey | null) {
    setPersonaSlotState(p);
    writeStoredPersonaSlot(p);
  }

  // Task #57: when the URL hash is `#persona-slot-A|B|C` (deep-linked from
  // the task detail "Active persona" panel), scroll the persona section
  // into view and auto-open the editor for that slot.
  //
  // Important gating: `usePersonas()` synchronously returns 3 fallback
  // slot views (id=null, content="") on first render before
  // `useListPersonas` resolves. If we acted on those, the editor would
  // open against stale fallback data and we'd consume the hash before the
  // canonical row arrived — so saves could overwrite the wrong content.
  // We therefore wait until `persona_slots_loading` flips to false AND
  // the matched slot has a non-null id (a confirmed live row), then
  // consume the hash exactly once.
  //
  // The hash is also re-checked on `hashchange` so a second click on the
  // same link from another tab/window still re-opens the editor.
  useEffect(() => {
    function handlePersonaHash() {
      if (persona_slots_loading) return;
      const slot_key = readPersonaSlotHash();
      if (!slot_key) return;
      const target = persona_slots.find((p) => p.slot === slot_key);
      // Without an id the live row hasn't been written yet (or doesn't
      // exist). Falling back to the synthetic view here would let the
      // user "save" against a phantom row, so we bail instead. This keeps
      // the deep-link a no-op for missing slots; the panel on the task
      // detail page already shows "no longer available" in that case.
      if (!target || !target.id) return;
      const el = document.getElementById("persona-slots-section");
      // scrollIntoView is missing in jsdom and some embedded browsers; we
      // probe before calling so the editor still opens even when the
      // scroll-into-view affordance is unavailable.
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      setEditingSlot(target);
      // Clear the hash so a manual close + refresh doesn't reopen.
      window.history.replaceState({}, "", window.location.pathname + window.location.search);
    }
    handlePersonaHash();
    window.addEventListener("hashchange", handlePersonaHash);
    return () => window.removeEventListener("hashchange", handlePersonaHash);
  }, [persona_slots, persona_slots_loading]);

  function submitTask(text: string, attachment_ids: string[], attachments: UploadedAttachment[]) {
    if (!text.trim() && attachment_ids.length === 0) return;

    const user_id = newMsgId();
    const assistant_id = newMsgId();
    const send_text = text.trim() || "(see attached files)";

    setMessages((prev) => [
      ...prev,
      { id: user_id, role: "user", text: send_text, attachments, ts: Date.now() },
      {
        id: assistant_id,
        role: "assistant",
        status: "pending",
        mode,
        max_models: maxModels,
        agents_per_model: agentsPerModel,
        ts: Date.now(),
      },
    ]);

    // Clear composer immediately (user message preserves the text in its bubble)
    setInput("");
    setResetSignal((n) => n + 1);

    // Inject local memory (browser-stored, layered below server canon) into the
    // task input so it reaches every model regardless of execution mode. We do
    // this client-side so the server's canon remains authoritative. Top-ranked
    // items by layer + recency, capped to a 500-token-equivalent budget.
    void buildLocalMemoryInjection(send_text, 500).then((injection) => {
      const final_input = injection
        ? `${injection}\n\n=== USER REQUEST ===\n${send_text}`
        : send_text;

      // Lattice continuity (Task #68): pin the new task to the open
      // conversation thread when there is one. The server clusterer
      // honors `conversation_id` as an explicit override (case 1) so
      // the task lands in the user-selected thread regardless of
      // Jaccard score. These fields are NOT in the orval-generated
      // CreateTaskBody schema yet — the server side-parses them with
      // its own zod schema, so we cast through `unknown` to stop TS
      // from stripping them at the boundary.
      const body = {
        input: final_input,
        mode,
        parallel_models: parallelCount,
        max_models: maxModels,
        agents_per_model: agentsPerModel,
        attachment_ids,
        ...(persona_slot ? { persona_slot } : {}),
        // Conversation routing: an explicit `conversation_id` always
        // wins server-side; otherwise, the one-shot manual override
        // (`force_new_conversation`) bypasses the Jaccard heuristic
        // for a single submit and forces a fresh thread. This is the
        // user's escape hatch when the auto-clusterer guesses wrong.
        ...(activeConversationId
          ? { conversation_id: activeConversationId }
          : forceNewConversation
            ? { force_new_conversation: true }
            : {}),
      } as unknown as Parameters<typeof createTask.mutate>[0]["data"];
      // Consume the one-shot override now that we've baked it into
      // the request body. If the server-side conversation creation
      // fails the user can simply click "+ New chat" again.
      if (forceNewConversation) setForceNewConversation(false);

      createTask.mutate(
        { data: body },
        {
          onSuccess: (task: {
            id: string;
            task_type: string;
            tri_state: string;
            selected_provider?: string;
            selected_model?: string;
            final_status: string;
            final_output?: string;
            run_id?: string;
            execution_mode?: string;
          }) => {
            let bos_output: BosOutput | undefined;
            let parse_error: string | undefined;
            if (task.final_output) {
              try {
                bos_output = JSON.parse(task.final_output);
              } catch (e) {
                parse_error = e instanceof Error ? e.message : "Unknown JSON parse error";
              }
            }
            setMessages((prev) =>
              prev.map((m): ChatMessage =>
                m.id === assistant_id
                  ? ({
                      ...(m as AssistantMessage),
                      status: parse_error ? "error" : "done",
                      error: parse_error
                        ? `Received malformed BOS output JSON: ${parse_error}. See raw payload below.`
                        : undefined,
                      task: {
                        task_id: task.id,
                        task_type: task.task_type,
                        tri_state: task.tri_state,
                        selected_provider: task.selected_provider,
                        selected_model: task.selected_model,
                        final_status: task.final_status,
                        final_output: task.final_output,
                        run_id: task.run_id,
                        execution_mode: task.execution_mode,
                        bos_output,
                      },
                    })
                  : m,
              ),
            );
            // Every successful task creation can either bump
            // last_active_at on an existing thread or create a brand
            // new one (especially under force_new_conversation), so
            // refresh both the sidebar and the active conversation
            // detail. Without this the new thread doesn't surface in
            // the sidebar until a manual reload.
            void qc.invalidateQueries({ queryKey: ["conversations", "sidebar"] });
            if (activeConversationId) {
              void qc.invalidateQueries({
                queryKey: ["conversation-detail", activeConversationId],
              });
            }
            // Task #64: bump the scratchpad refetch counter so the
            // live ScratchpadPanel re-queries and the new
            // auto-summary row written by the orchestrator at task
            // completion appears without a manual reload.
            setScratchpadRefetchKey((n) => n + 1);
          },
          onError: (err: unknown) => {
            const message = err instanceof Error ? err.message : "Pipeline request failed";
            setMessages((prev) =>
              prev.map((m): ChatMessage =>
                m.id === assistant_id
                  ? ({ ...(m as AssistantMessage), status: "error", error: message })
                  : m,
              ),
            );
          },
        },
      );
    });
  }

  // Wire the always-current submitTask closure into the regenerate
  // event handler set up earlier. Done here (after submitTask is in
  // scope) so the handler always sees the latest mode / parallelCount /
  // persona_slot / etc. — without this, a stale closure from first
  // render would freeze those values.
  regenerateHandlerRef.current = (prompt: string) => {
    submitTask(prompt, [], []);
  };

  const selected_mode_info = MODE_OPTIONS.find((m) => m.value === mode)!;

  return (
    <div className="space-y-8">
      {/* Page header */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="space-y-1 min-w-0">
          <h1 className="text-2xl font-serif font-semibold text-foreground tracking-tight" data-testid="text-task-console-title">
            {activeConversationId && conversationDetail
              ? conversationDetail.conversation.title
              : "Task console"}
          </h1>
          <p className="text-[13.5px] text-muted-foreground max-w-2xl">
            {activeConversationId
              ? "Continuing this conversation. New tasks pin to this thread automatically."
              : "Submit a task and let BOS-Omega orchestrate the optimal multi-model execution strategy."}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Task #64: Cross-AI continuity bundle controls. Copy is
              enabled once we have a current task or active conversation
              to scope the bundle to. Rehydrate is always available so
              the user can paste a bundle from another session anytime. */}
          {(currentTaskId || activeConversationId) && (
            <CopyContinuityBundle
              taskId={currentTaskId}
              conversationId={activeConversationId}
              compact
              label="Copy bundle"
            />
          )}
          <button
            type="button"
            onClick={() => setRehydrateOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="Paste a continuity bundle to rehydrate a thread"
            data-testid="button-open-rehydrate"
          >
            <ClipboardPaste className="w-3.5 h-3.5" />
            Rehydrate
          </button>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setMessages([]);
                // Arm the one-shot manual override so the next submit is
                // forced into a brand-new conversation, regardless of
                // whether the input would have Jaccard-matched something
                // that already exists. Clearing activeConversationId
                // (via the URL param) PLUS arming the override is what
                // makes "+ New chat" actually mean "new", not "maybe
                // new, depends on similarity".
                setForceNewConversation(true);
                if (activeConversationId) {
                  window.history.pushState({}, "", "/console");
                  void qc.invalidateQueries({ queryKey: ["conversations", "sidebar"] });
                  void qc.invalidateQueries({ queryKey: ["conversation-detail"] });
                }
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              title="Start a new conversation"
              data-testid="button-new-chat"
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
              New chat
            </button>
          )}
        </div>
      </header>

      {/* Task #64: Rehydrate-from-bundle modal. The modal navigates the
          user into the new conversation on success (navigateOnImport=true)
          and busts the conversations sidebar cache so the new thread
          shows up immediately. */}
      <RehydrateBundleModal
        open={rehydrateOpen}
        onClose={() => setRehydrateOpen(false)}
        navigateOnImport
      />

      {/* Stats bar — wraps from 2-col on mobile to 3-col on tablet to 6-col on desktop */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "Total", value: stats.total_tasks, accent: "text-foreground" },
            { label: "Go", value: stats.go_count, accent: "text-green-700" },
            { label: "Hold", value: stats.hold_count, accent: "text-amber-700" },
            { label: "Abort", value: stats.abort_count, accent: "text-red-700" },
            { label: "Avg latency", value: formatMs(stats.avg_latency_ms), accent: "text-foreground" },
            { label: "Success rate", value: `${((stats.success_rate || 0) * 100).toFixed(0)}%`, accent: "text-green-700" },
          ].map((s) => (
            <div key={s.label} className="bg-card border border-card-border rounded-xl p-3 sm:p-4 shadow-card min-w-0">
              <div className="text-[10.5px] text-muted-foreground font-medium tracking-wide uppercase truncate">{s.label}</div>
              <div className={`text-xl sm:text-2xl font-serif font-semibold mt-1 sm:mt-1.5 tracking-tight truncate ${s.accent}`}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Conversation thread */}
      {messages.length > 0 && (
        <MessageList messages={messages} />
      )}

      {/* Task #64: live scratchpad — task-scoped when we have a
          current task, conversation-scoped fallback otherwise. The
          panel exposes pin/edit/delete so the user can curate what
          rides into the next prompt. The refetchKey bump above forces
          a re-fetch right after a task completes so the
          orchestrator-written auto-summary appears immediately. */}
      {(currentTaskId || activeConversationId) && (
        <ScratchpadPanel
          taskId={currentTaskId}
          refetchKey={scratchpadRefetchKey}
        />
      )}

      {/* Input form */}
      <div className="bg-card border border-card-border rounded-xl p-6 shadow-card">
        <div className="flex items-center gap-3 mb-5">
          <h2 className="text-[15px] font-serif font-semibold text-foreground tracking-tight">
            {messages.length === 0 ? "New task" : "Reply"}
          </h2>
          {selected_mode_info.cost && (
            <span className={`ml-auto inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-medium ${COST_LABEL[selected_mode_info.cost]!.color}`}>
              {COST_LABEL[selected_mode_info.cost]!.label}
            </span>
          )}
        </div>

        {/* Persona quick-launch */}
        <div className="mb-5" id="persona-slots-section">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-[12.5px] font-medium text-foreground">Domain persona</label>
            {persona_slot && (
              <button
                type="button"
                onClick={() => setPersonaSlot(null)}
                className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
                data-testid="button-clear-persona"
              >
                <X className="w-3 h-3" />
                Clear
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {persona_slots.map((p) => {
              const presentation = PERSONA_PRESENTATION[p.slot];
              const Icon = presentation.icon;
              const active = persona_slot === p.slot;
              return (
                <div
                  key={p.slot}
                  className={`relative flex flex-col items-start gap-1.5 p-3 rounded-lg border text-left transition-all ${
                    active ? presentation.activeColor : `bg-background ${presentation.color}`
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setPersonaSlot(active ? null : p.slot)}
                    className="flex flex-col items-start gap-1.5 w-full text-left"
                    data-testid={`button-persona-${p.slot.toLowerCase()}`}
                    title={p.content || "Click to edit this persona"}
                  >
                    <div className="flex items-center gap-2 w-full pr-7">
                      <Icon className={`w-4 h-4 shrink-0 ${active ? "text-foreground" : "text-muted-foreground"}`} />
                      <span className="text-[13px] font-medium text-foreground truncate">{p.title}</span>
                      {active && (
                        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-foreground/10 text-foreground font-medium uppercase tracking-wide shrink-0">
                          Active
                        </span>
                      )}
                    </div>
                    <span className="text-[11.5px] leading-snug text-muted-foreground line-clamp-2">
                      {personaSummary(p.content)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingSlot(p);
                    }}
                    className="absolute top-2 right-2 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
                    title={`Edit slot ${p.slot}`}
                    aria-label={`Edit persona slot ${p.slot}`}
                    data-testid={`button-edit-persona-${p.slot.toLowerCase()}`}
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Personas compose with the Master Prompt Kernel and apply across every execution mode while preserving BOS structured output.
            Click the gear to rename a slot or rewrite its instruction.
          </p>
        </div>
        <PersonaEditor
          slot={editing_slot}
          open={editing_slot !== null}
          onOpenChange={(o) => {
            if (!o) setEditingSlot(null);
          }}
        />

        {/* Mode selector */}
        <div className="mb-5">
          <label className="block text-[12.5px] font-medium text-foreground mb-2">Execution mode</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-2.5">
            {MODE_OPTIONS.slice(0, 3).map((m) => {
              const Icon = m.icon;
              const active = mode === m.value;
              return (
                <button
                  key={m.value}
                  onClick={() => setMode(m.value)}
                  className={`flex flex-col items-start gap-1.5 p-3.5 rounded-lg border text-left transition-all ${
                    active
                      ? "bg-secondary border-border ring-2 ring-primary/10"
                      : "bg-background border-border hover:border-border hover:bg-secondary/50"
                  }`}
                >
                  <div className="flex items-center gap-2 w-full">
                    <Icon className={`w-4 h-4 shrink-0 ${active ? "text-accent" : "text-muted-foreground"}`} />
                    <span className={`text-[13px] font-medium ${active ? "text-foreground" : "text-foreground/90"}`}>{m.label}</span>
                    {m.badge && (
                      <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border ${m.badgeColor}`}>{m.badge}</span>
                    )}
                  </div>
                  <span className="text-[11.5px] leading-snug text-muted-foreground">{m.desc}</span>
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {MODE_OPTIONS.slice(3).map((m) => {
              const Icon = m.icon;
              const active = mode === m.value;
              return (
                <button
                  key={m.value}
                  onClick={() => setMode(m.value)}
                  className={`flex flex-col items-start gap-1.5 p-3.5 rounded-lg border text-left transition-all ${
                    active
                      ? "bg-secondary border-border ring-2 ring-primary/10"
                      : "bg-background border-border hover:border-border hover:bg-secondary/50"
                  }`}
                >
                  <div className="flex items-center gap-2 w-full">
                    <Icon className={`w-4 h-4 shrink-0 ${active ? "text-accent" : "text-muted-foreground"}`} />
                    <span className={`text-[13px] font-medium ${active ? "text-foreground" : "text-foreground/90"}`}>{m.label}</span>
                    {m.badge && (
                      <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border ${m.badgeColor}`}>{m.badge}</span>
                    )}
                  </div>
                  <span className="text-[11.5px] leading-snug text-muted-foreground">{m.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Mode-specific notices */}
        {mode === "boil_the_ocean" && (
          <div className="mb-5 flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-[13px] font-medium text-red-900">High API spend warning</p>
              <p className="text-[12px] text-red-800/90 mt-1 leading-relaxed">
                Boil the ocean dispatches up to {maxModels} providers × {agentsPerModel} agents = <strong>{maxModels * agentsPerModel} parallel LLM calls</strong>, plus synthesis and adversarial review. This can incur significant cost.
              </p>
            </div>
          </div>
        )}

        {mode === "series_pass" && (
          <div className="mb-5 flex items-start gap-3 p-4 bg-violet-50 border border-violet-200 rounded-lg">
            <CheckCircle2 className="w-4 h-4 text-violet-700 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-[13px] font-medium text-violet-900">Sequential 5-role refinement</p>
              <p className="text-[12px] text-violet-800/90 mt-1 leading-relaxed">
                Drafter → Critic → Expander → Adversary → Synthesizer. Each model builds on the previous one, finding errors and improving the answer in sequence.
              </p>
            </div>
          </div>
        )}

        {/* Config controls */}
        {(mode === "parallel" || mode === "consensus") && (
          <div className="mb-5 flex items-center gap-3">
            <label className="text-[12.5px] font-medium text-foreground">Parallel models</label>
            <div className="flex gap-1.5">
              {[2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setParallelCount(n)}
                  className={`w-9 h-9 rounded-md border text-[13px] font-medium transition-all ${
                    parallelCount === n
                      ? "bg-primary text-primary-foreground border-primary shadow-card"
                      : "bg-background border-border text-muted-foreground hover:border-primary hover:text-foreground"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === "boil_the_ocean" && (
          <div className="mb-5 grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[12.5px] font-medium text-foreground block">Max providers</label>
              <div className="flex gap-1.5">
                {[2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setMaxModels(n)}
                    className={`w-9 h-9 rounded-md border text-[13px] font-medium transition-all ${
                      maxModels === n
                        ? "bg-primary text-primary-foreground border-primary shadow-card"
                        : "bg-background border-border text-muted-foreground hover:border-primary hover:text-foreground"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[12.5px] font-medium text-foreground block">
                Agents per provider <span className="text-muted-foreground font-normal">· total {maxModels * agentsPerModel}</span>
              </label>
              <div className="flex gap-1.5">
                {[3, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setAgentsPerModel(n)}
                    className={`w-9 h-9 rounded-md border text-[13px] font-medium transition-all ${
                      agentsPerModel === n
                        ? "bg-primary text-primary-foreground border-primary shadow-card"
                        : "bg-background border-border text-muted-foreground hover:border-primary hover:text-foreground"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* BOP.FRONT_DOOR.v1 — first-run prompt cards. Shown only on the
            empty conversation, so the user immediately understands what
            kind of work BOS-OMEGA was built for. */}
        {messages.length === 0 && (
          <div className="mb-5" data-testid="front-door-empty-state">
            <div className="mb-2 flex items-baseline justify-between">
              <label className="block text-[12.5px] font-medium text-foreground">
                Try a task
              </label>
              <span className="text-[11px] text-muted-foreground">
                BOS-OMEGA is a structured decision engine — not a chat companion.
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {FRONT_DOOR_PROMPTS.map((p) => {
                const Icon = p.icon;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setInput(p.prompt)}
                    className={`flex flex-col items-start gap-1.5 p-3 rounded-lg border text-left transition-all ${p.accent}`}
                    data-testid={`button-front-door-prompt-${p.key}`}
                  >
                    <div className="flex items-center gap-2 w-full">
                      <Icon className="w-4 h-4 shrink-0 text-muted-foreground" />
                      <span className="text-[13px] font-medium text-foreground">{p.label}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground font-mono uppercase">Try</span>
                    </div>
                    <span className="text-[11.5px] leading-snug text-muted-foreground">{p.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <label className="block text-[12.5px] font-medium text-foreground">
            {messages.length === 0 ? "Task description" : "Send another message"}
          </label>
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={submitTask}
            disabled={createTask.isPending}
            resetSignal={resetSignal}
            placeholder={
              mode === "series_pass"
                ? "Ask BOS-OMEGA a decision, review, risk check, or build task that benefits from iterative refinement…"
                : mode === "boil_the_ocean"
                ? "Ask BOS-OMEGA a high-stakes decision, review, risk check, or build task. Attach reference docs as needed…"
                : mode === "auto"
                ? "Ask BOS-OMEGA a decision, review, risk check, or build task. Examples: \"Should we approve this vendor?\", \"Review this PR for risk.\", \"Build a step-by-step fix plan.\""
                : "Ask BOS-OMEGA a decision, review, risk check, or build task…"
            }
            submitLabel={
              createTask.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {mode === "boil_the_ocean" ? "Boiling the ocean…" : mode === "series_pass" ? "Running series pass…" : "Running pipeline…"}
                </>
              ) : (
                <>
                  {mode === "boil_the_ocean" ? <Flame className="w-4 h-4" /> : <Send className="w-4 h-4" />}
                  {mode === "boil_the_ocean"
                    ? `Boil the ocean (${maxModels * agentsPerModel} agents)`
                    : mode === "series_pass"
                    ? "Run series pass"
                    : "Send"}
                </>
              )
            }
            submitClassName={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-card ${
              mode === "boil_the_ocean"
                ? "bg-red-700 text-white hover:bg-red-800"
                : mode === "series_pass"
                ? "bg-violet-700 text-white hover:bg-violet-800"
                : "bg-accent text-accent-foreground hover:bg-accent/90"
            }`}
          />
          <div className="text-[11px] text-muted-foreground text-right">
            {input.length} characters
          </div>
        </div>
      </div>
    </div>
  );
}
