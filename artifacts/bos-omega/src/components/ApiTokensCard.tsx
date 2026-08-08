import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Key, Copy, Trash2, Plus, X, Check, ShieldAlert, ShieldCheck, Terminal,
  Eye, EyeOff, AlertTriangle, ExternalLink, Download, Eraser,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";

// ======================================================================
// API Tokens — Settings card
//
// The card lets a logged-in admin / super_admin mint, list, and revoke
// BOS-OMEGA API tokens. Tokens are the credential the external API
// (POST /api/external/*) accepts in `Authorization: Bearer bos_xxx_yyy`.
//
// Plaintext is shown EXACTLY once on creation and never again. We only
// store the prefix and the sha256 hash server-side.
// ======================================================================

const ALL_SCOPES = [
  { id: "memory:read", desc: "Read memory items (all layers)" },
  { id: "memory:write", desc: "Create / update / delete generic memory items" },
  { id: "memory:canon:read", desc: "Read canon (system-law) memory items" },
  { id: "memory:canon:write", desc: "Create / update / delete canon items" },
  { id: "memory:scratchpad:read", desc: "Read scratchpad items" },
  { id: "memory:scratchpad:write", desc: "Create / update / delete scratchpad items" },
  { id: "memory:continuity:read", desc: "Read continuity memory items" },
  { id: "memory:continuity:write", desc: "Create / update / delete continuity items" },
  { id: "conversations:read", desc: "List / get conversations" },
  { id: "conversations:write", desc: "Update / create conversations" },
  { id: "tasks:read", desc: "List / get tasks" },
  { id: "tasks:write", desc: "Submit new tasks" },
  { id: "audit:read", desc: "Read the audit log" },
  { id: "continuity:export", desc: "Export bos-omega.continuity-bundle.v1" },
  { id: "continuity:import", desc: "Rehydrate from a bundle" },
] as const;

interface ApiTokenRow {
  id: string;
  name: string;
  mask: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  power_shell_only: boolean;
  active: boolean;
}

interface ApiTokenCreateResponse {
  id: string;
  name: string;
  plaintext: string;
  mask: string;
  scopes: string[];
  expires_at: string | null;
  power_shell_only: boolean;
  created_at: string;
  warning: string;
}

interface ApiTokenAuditRow {
  id: string;
  token_id: string | null;
  event_type: string;
  ip: string | null;
  user_agent: string | null;
  metadata: unknown;
  created_at: string;
}

async function fetchTokens(): Promise<{ tokens: ApiTokenRow[] }> {
  const r = await fetch("/api/tokens", { credentials: "include" });
  if (!r.ok) throw new Error(`Failed to load tokens: ${r.status}`);
  return r.json();
}
async function fetchTokenAudit(): Promise<{ events: ApiTokenAuditRow[] }> {
  const r = await fetch("/api/tokens/audit?limit=50", { credentials: "include" });
  if (!r.ok) throw new Error(`Failed to load audit: ${r.status}`);
  return r.json();
}
async function createToken(body: {
  name: string;
  scopes: string[];
  expires_in_days?: number;
  power_shell_only?: boolean;
}): Promise<ApiTokenCreateResponse> {
  const r = await fetch("/api/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `Create failed: ${r.status}`);
  }
  return r.json();
}
async function revokeToken(id: string, reason?: string): Promise<void> {
  const r = await fetch(`/api/tokens/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ reason }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `Revoke failed: ${r.status}`);
  }
}
async function deleteToken(id: string): Promise<void> {
  const r = await fetch(`/api/tokens/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!r.ok && r.status !== 204) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `Delete failed: ${r.status}`);
  }
}
async function wipeRevokedTokens(): Promise<{ removed: number }> {
  const r = await fetch(`/api/tokens?revoked_only=1`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `Wipe failed: ${r.status}`);
  }
  return r.json();
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-border text-[11px] font-medium text-foreground hover:bg-secondary transition-colors"
      data-testid={`button-copy-${label.toLowerCase()}`}
    >
      {copied ? <Check className="w-3 h-3 text-green-700" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

function PowerShellSnippet({ token, baseUrl }: { token: string; baseUrl: string }) {
  const ps = [
    `# BOS-OMEGA PowerShell bridge — paste into a PowerShell session`,
    `$env:BOS_OMEGA_TOKEN = "${token}"`,
    `$env:BOS_OMEGA_BASE  = "${baseUrl}"`,
    ``,
    `function Invoke-Bos {`,
    `  param(`,
    `    [Parameter(Mandatory)] [string] $Path,`,
    `    [Parameter()] [string] $Method = "GET",`,
    `    [Parameter()] [object] $Body,`,
    `  )`,
    `  $headers = @{ Authorization = "Bearer $env:BOS_OMEGA_TOKEN" }`,
    `  $uri = "$env:BOS_OMEGA_BASE/api/external/$Path"`,
    `  if ($Body) {`,
    `    Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -Body ($Body | ConvertTo-Json -Depth 10) -ContentType "application/json"`,
    `  } else {`,
    `    Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers`,
    `  }`,
    `}`,
    ``,
    `# Examples:`,
    `# Invoke-Bos -Path "memory?layer=canon"`,
    `# Invoke-Bos -Path "tasks?tri_state=HOLD&limit=10"`,
    `# Invoke-Bos -Path "audit?event_type=TASK_COMPLETED" -Method GET`,
    `# Invoke-Bos -Path "conversations" -Method GET`,
    ``,
    `# Note: a PowerShell-only token (set at creation) refuses requests`,
    `# whose User-Agent looks like a browser — this is the safe-bridge`,
    `# posture for the operator console.`,
  ].join("\n");
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Terminal className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-[11.5px] font-medium text-foreground">PowerShell bridge</span>
        <CopyButton value={ps} label="Copy PS" />
      </div>
      <pre className="text-[10.5px] font-mono leading-snug text-foreground bg-foreground/5 border border-border rounded-md p-3 overflow-x-auto whitespace-pre">
        {ps}
      </pre>
    </div>
  );
}

function CurlSnippet({ token, baseUrl }: { token: string; baseUrl: string }) {
  const curl = [
    `# cURL — same endpoints, raw HTTP`,
    `export BOS_TOKEN="${token}"`,
    `export BOS_BASE="${baseUrl}"`,
    ``,
    `curl -s -H "Authorization: Bearer $BOS_TOKEN" "$BOS_BASE/api/external/me"`,
    `curl -s -H "Authorization: Bearer $BOS_TOKEN" "$BOS_BASE/api/external/memory?layer=canon"`,
    `curl -s -H "Authorization: Bearer $BOS_TOKEN" "$BOS_BASE/api/external/tasks?tri_state=GO&limit=5"`,
    `curl -s -H "Authorization: Bearer $BOS_TOKEN" "$BOS_BASE/api/external/audit?event_type=AUTH_LOGIN_SUCCESS"`,
  ].join("\n");
  return (
    <details className="group">
      <summary className="cursor-pointer text-[11.5px] text-muted-foreground hover:text-foreground select-none flex items-center gap-1">
        <span className="group-open:rotate-90 transition-transform">▶</span> cURL
      </summary>
      <pre className="text-[10.5px] font-mono leading-snug text-foreground bg-foreground/5 border border-border rounded-md p-3 mt-2 overflow-x-auto whitespace-pre">
        {curl}
      </pre>
    </details>
  );
}

function CreateTokenDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [scopeSel, setScopeSel] = useState<Set<string>>(new Set(["memory:read", "tasks:read"]));
  const [psOnly, setPsOnly] = useState(false);
  // "never" is the default. The user can pick 30 / 90 / 365 days.
  const [expiresInDays, setExpiresInDays] = useState<number | "never">("never");
  const [created, setCreated] = useState<ApiTokenCreateResponse | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  // Autofocus the name field so the create flow is one keystroke deep
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  const create = useMutation({
    mutationFn: createToken,
    onSuccess: (resp) => {
      setCreated(resp);
      void qc.invalidateQueries({ queryKey: ["api-tokens"] });
      void qc.invalidateQueries({ queryKey: ["api-tokens-audit"] });
    },
  });

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const toggleScope = (s: string) => {
    setScopeSel((cur) => {
      const next = new Set(cur);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };
  const selectAll = () => setScopeSel(new Set(ALL_SCOPES.map((s) => s.id)));
  const selectNone = () => setScopeSel(new Set());

  return (
    <div className="fixed inset-0 z-50 bg-foreground/40 flex items-end sm:items-center justify-center p-3 sm:p-6" onClick={onClose}>
      <div
        className="bg-card border border-card-border rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-[14px] font-serif font-semibold text-foreground tracking-tight flex items-center gap-2">
            <Key className="w-4 h-4" />
            {created ? "Token created" : "New API token"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-secondary"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {created ? (
          <div className="p-5 space-y-4">
            <div className="flex items-start gap-2 p-3 rounded-md border border-amber-300 bg-amber-50 text-amber-900">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <p className="text-[12px] leading-snug">
                {created.warning}
              </p>
            </div>
            <div>
              <label className="block text-[11.5px] font-medium text-muted-foreground mb-1">
                Token (shown once)
              </label>
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 text-[12px] font-mono text-foreground bg-foreground/5 border border-border rounded-md px-3 py-2 overflow-x-auto"
                  data-testid="text-new-token"
                >
                  {created.plaintext}
                </code>
                <CopyButton value={created.plaintext} label="Copy" />
              </div>
              <p className="text-[10.5px] text-muted-foreground mt-1">
                Mask form (what the UI will show later): <code>{created.mask}</code>
              </p>
            </div>
            <div className="border-t border-border pt-4 space-y-3">
              <PowerShellSnippet token={created.plaintext} baseUrl={baseUrl} />
              <CurlSnippet token={created.plaintext} baseUrl={baseUrl} />
            </div>
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-[12px] font-medium"
                data-testid="button-close-created"
              >
                I&apos;ve saved the token — close
              </button>
            </div>
          </div>
        ) : (
          <form
            className="p-5 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || scopeSel.size === 0) return;
              create.mutate({
                name: name.trim(),
                scopes: Array.from(scopeSel),
                expires_in_days: typeof expiresInDays === "number" ? expiresInDays : undefined,
                power_shell_only: psOnly,
              });
            }}
          >
            <div>
              <label className="block text-[11.5px] font-medium text-foreground mb-1">
                Name
              </label>
              <input
                ref={nameInputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. power-shell-bridge"
                className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-[12.5px] text-foreground"
                data-testid="input-token-name"
                required
              />
              {!name.trim() && (
                <p className="text-[10.5px] text-amber-700 mt-1">
                  Type a label first — the button enables once the name + at least one scope is set.
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11.5px] font-medium text-foreground">
                  Scopes ({scopeSel.size} of {ALL_SCOPES.length})
                </label>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="text-[10.5px] text-muted-foreground hover:text-foreground"
                  >
                    All
                  </button>
                  <span className="text-muted-foreground">·</span>
                  <button
                    type="button"
                    onClick={selectNone}
                    className="text-[10.5px] text-muted-foreground hover:text-foreground"
                  >
                    None
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-72 overflow-y-auto p-1">
                {ALL_SCOPES.map((s) => {
                  const checked = scopeSel.has(s.id);
                  return (
                    <label
                      key={s.id}
                      className={`flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors ${
                        checked
                          ? "border-foreground/30 bg-secondary"
                          : "border-border bg-background hover:bg-secondary/50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleScope(s.id)}
                        className="mt-0.5"
                        data-testid={`checkbox-scope-${s.id}`}
                      />
                      <div className="min-w-0">
                        <div className="text-[11.5px] font-mono text-foreground">{s.id}</div>
                        <div className="text-[10.5px] text-muted-foreground leading-snug">{s.desc}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11.5px] font-medium text-foreground mb-1">
                  Expires
                </label>
                <select
                  value={expiresInDays === "never" ? "never" : String(expiresInDays)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setExpiresInDays(v === "never" ? "never" : parseInt(v, 10));
                  }}
                  className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-[12.5px] text-foreground"
                  data-testid="select-expiry"
                >
                  <option value="never">Never</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="180">180 days</option>
                  <option value="365">365 days (1 year)</option>
                </select>
              </div>
              <label className="flex items-start gap-2 p-2 rounded border border-border bg-background cursor-pointer mt-auto">
                <input
                  type="checkbox"
                  checked={psOnly}
                  onChange={(e) => setPsOnly(e.target.checked)}
                  className="mt-0.5"
                  data-testid="checkbox-powershell-only"
                />
                <div className="min-w-0">
                  <div className="text-[11.5px] font-medium text-foreground">PowerShell-only</div>
                  <div className="text-[10.5px] text-muted-foreground leading-snug">
                    Reject browser User-Agents. Use for the local bridge.
                  </div>
                </div>
              </label>
            </div>

            {create.error && (
              <p className="text-[11.5px] text-red-700" data-testid="text-create-error">
                {(create.error as Error).message}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2 border-t border-border">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-md border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!name.trim() || scopeSel.size === 0 || create.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-[12px] font-medium disabled:opacity-50"
                data-testid="button-create-token"
              >
                {create.isPending ? "Creating…" : "Create token"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ token }: { token: ApiTokenRow }) {
  if (token.revoked_at) {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">
        <ShieldAlert className="w-3 h-3" /> Revoked
      </span>
    );
  }
  if (token.expires_at && new Date(token.expires_at).getTime() < Date.now()) {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
        Expired
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200">
      <ShieldCheck className="w-3 h-3" /> Active
    </span>
  );
}

export function ApiTokensCard() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [showAudit, setShowAudit] = useState(false);

  const tokens = useQuery({
    queryKey: ["api-tokens"],
    queryFn: fetchTokens,
    staleTime: 15_000,
  });
  const audit = useQuery({
    queryKey: ["api-tokens-audit"],
    queryFn: fetchTokenAudit,
    staleTime: 15_000,
    enabled: showAudit,
  });

  const revoke = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => revokeToken(id, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["api-tokens"] });
      void qc.invalidateQueries({ queryKey: ["api-tokens-audit"] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteToken(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["api-tokens"] });
      void qc.invalidateQueries({ queryKey: ["api-tokens-audit"] });
    },
  });
  const wipe = useMutation({
    mutationFn: () => wipeRevokedTokens(),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["api-tokens"] });
      void qc.invalidateQueries({ queryKey: ["api-tokens-audit"] });
      toast({
        title: "Wiped revoked tokens",
        description: `Removed ${res.removed} revoked token${res.removed === 1 ? "" : "s"}.`,
      });
    },
  });

  const rows = useMemo(() => tokens.data?.tokens ?? [], [tokens.data]);
  const activeCount = rows.filter((r) => r.active).length;

  return (
    <section className="bg-card border border-card-border rounded-xl p-6 shadow-card space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-[15px] font-serif font-semibold text-foreground tracking-tight flex items-center gap-2">
            <Key className="w-4 h-4" />
            API tokens
          </h2>
          <p className="text-[12.5px] text-muted-foreground mt-0.5 max-w-2xl">
            Mint scoped tokens to drive the BOS-OMEGA external API
            (<code className="font-mono text-foreground">/api/external/*</code>) from scripts, the local PowerShell bridge, or
            other AURA-OMEGA agents. Plaintext is shown once on creation
            and never stored. See the in-app{" "}
            <a
              href="https://github.com/ABBYCRM/BOS-OMEGA-Frontend#api-tokens"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline underline-offset-2 inline-flex items-center gap-0.5"
            >
              docs <ExternalLink className="w-3 h-3" />
            </a>{" "}
            for the full surface.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground">
            {activeCount} active / {rows.length} total
          </span>
          {rows.some((r) => r.revoked_at) && (
            <button
              type="button"
              onClick={() => {
                const revokedCount = rows.filter((r) => r.revoked_at).length;
                if (confirm(`Wipe ${revokedCount} revoked token${revokedCount === 1 ? "" : "s"}? This removes the rows from the DB. Audit history is kept.`)) {
                  wipe.mutate();
                }
              }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary"
              data-testid="button-wipe-revoked"
              disabled={wipe.isPending}
            >
              <Eraser className="w-3.5 h-3.5" />
              {wipe.isPending ? "Wiping…" : "Wipe revoked"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-[12px] font-medium"
            data-testid="button-new-token"
          >
            <Plus className="w-3.5 h-3.5" />
            New token
          </button>
        </div>
      </div>

      {tokens.isLoading && (
        <div className="text-[12px] text-muted-foreground">Loading…</div>
      )}
      {tokens.error && (
        <div className="text-[12px] text-red-700">
          {(tokens.error as Error).message}
        </div>
      )}

      {rows.length === 0 && !tokens.isLoading && (
        <div className="text-[12px] text-muted-foreground border border-dashed border-border rounded-md p-4 text-center">
          No tokens yet. Click <strong>New token</strong> to mint one.
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-[12px] min-w-[700px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-2 font-medium">Name</th>
                <th className="px-2 py-2 font-medium">Token</th>
                <th className="px-2 py-2 font-medium">Scopes</th>
                <th className="px-2 py-2 font-medium">Last used</th>
                <th className="px-2 py-2 font-medium">Created</th>
                <th className="px-2 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t.id}
                  className="border-t border-border hover:bg-secondary/30"
                  data-testid={`row-token-${t.id}`}
                >
                  <td className="px-2 py-2 align-top">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-foreground">{t.name}</span>
                      <StatusBadge token={t} />
                      {t.power_shell_only && (
                        <span className="inline-flex items-center gap-0.5 text-[9.5px] font-mono px-1 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200">
                          <Terminal className="w-2.5 h-2.5" /> PS-only
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2 align-top">
                    <code className="text-[11px] font-mono text-muted-foreground">{t.mask}</code>
                  </td>
                  <td className="px-2 py-2 align-top">
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {t.scopes.length === 0 && (
                        <span className="text-[10.5px] text-muted-foreground">none</span>
                      )}
                      {t.scopes.slice(0, 4).map((s) => (
                        <span
                          key={s}
                          className="text-[10px] font-mono px-1 py-0.5 rounded bg-foreground/5 border border-border"
                        >
                          {s}
                        </span>
                      ))}
                      {t.scopes.length > 4 && (
                        <span className="text-[10px] text-muted-foreground">
                          +{t.scopes.length - 4}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2 align-top text-muted-foreground text-[11px]">
                    {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : <span className="italic">never</span>}
                  </td>
                  <td className="px-2 py-2 align-top text-muted-foreground text-[11px]">
                    {new Date(t.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-2 py-2 align-top text-right">
                    <div className="inline-flex items-center gap-1">
                      {t.active && (
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(`Revoke "${t.name}"? The plaintext is already gone — this kills the row from the live UI. You can still hard-delete it after.`)) {
                              revoke.mutate({ id: t.id, reason: "user revoked" });
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-red-700 hover:bg-red-50"
                          data-testid={`button-revoke-${t.id}`}
                        >
                          <Trash2 className="w-3 h-3" /> Revoke
                        </button>
                      )}
                      {t.revoked_at && (
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(`Hard-delete "${t.name}"? This removes the row from the DB. Audit history is kept.`)) {
                              del.mutate(t.id);
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-foreground/60 hover:bg-foreground/5 hover:text-foreground"
                          data-testid={`button-delete-${t.id}`}
                        >
                          <Eraser className="w-3 h-3" /> Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revoke.error && (
        <p className="text-[11.5px] text-red-700">{(revoke.error as Error).message}</p>
      )}
      {del.error && (
        <p className="text-[11.5px] text-red-700">{(del.error as Error).message}</p>
      )}
      {wipe.error && (
        <p className="text-[11.5px] text-red-700">{(wipe.error as Error).message}</p>
      )}

      <div className="pt-2 border-t border-border">
        <button
          type="button"
          onClick={() => setShowAudit((v) => !v)}
          className="text-[11.5px] text-muted-foreground hover:text-foreground"
          data-testid="button-toggle-audit"
        >
          {showAudit ? "Hide" : "Show"} token audit log
        </button>
        {showAudit && (
          <div className="mt-3 space-y-1 max-h-72 overflow-y-auto">
            {audit.isLoading && <div className="text-[11px] text-muted-foreground">Loading…</div>}
            {audit.data?.events?.map((e) => (
              <div
                key={e.id}
                className="flex items-baseline gap-3 text-[11px] font-mono border-b border-border/50 py-1.5"
              >
                <span className="text-muted-foreground shrink-0">
                  {new Date(e.created_at).toLocaleString()}
                </span>
                <span
                  className={`shrink-0 px-1 py-0.5 rounded text-[10px] ${
                    e.event_type === "USE"
                      ? "bg-green-50 text-green-700"
                      : e.event_type === "USE_FAILED" || e.event_type === "SCOPE_DENIED"
                        ? "bg-red-50 text-red-700"
                        : e.event_type === "REVOKE"
                          ? "bg-amber-50 text-amber-700"
                          : "bg-foreground/5 text-foreground"
                  }`}
                >
                  {e.event_type}
                </span>
                <span className="text-muted-foreground truncate min-w-0">{e.ip ?? "—"}</span>
                <span className="text-muted-foreground truncate min-w-0 flex-1">
                  {e.user_agent ?? "—"}
                </span>
              </div>
            ))}
            {audit.data?.events?.length === 0 && (
              <div className="text-[11px] text-muted-foreground">No events yet.</div>
            )}
          </div>
        )}
      </div>

      {showCreate && <CreateTokenDialog onClose={() => setShowCreate(false)} />}
    </section>
  );
}
