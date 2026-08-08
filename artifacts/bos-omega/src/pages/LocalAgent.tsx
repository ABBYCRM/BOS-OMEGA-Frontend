import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAuthState } from "@/lib/auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Building2, Lock, Server, ShieldCheck, Loader2, Copy, Check } from "lucide-react";
import { formatDate } from "@/lib/utils";

/**
 * Local Agent page.
 *
 * Tabs:
 *   - Devices: paired Windows agents and their session/health state.
 *     Surface owned by Task #23; this task scaffolds a placeholder so
 *     the page is mountable today.
 *   - Policy: device-local policy editor (Task #21/#23). Placeholder.
 *   - Enterprise: super_admin-only. Org list + per-org policy lock
 *     editor + per-org device list. Wired against the routes added in
 *     this task.
 */

type Org = {
  id: string;
  slug: string;
  display_name: string;
  status: string;
  has_enrollment_secret: boolean;
  created_at: string;
  updated_at: string;
};

type OrgDevice = {
  id: string;
  org_id: string | null;
  install_mode: string;
  display_name: string;
  hostname: string | null;
  status: string;
  paired_at: string;
  last_seen_at: string | null;
  contract_version: string;
};

type PolicyOverride = {
  id: string;
  org_id: string;
  policy_field_path: string;
  locked_value: unknown;
  set_by_user_id: string;
  set_at: string;
};

const API = "/api/v1";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = (await r.json()) as {
        error?: string;
        issues?: Array<{ path?: unknown; message?: string }>;
      };
      if (j.error) msg = j.error;
      // Surface field-level validation issues so the operator knows which
      // input is wrong (slug regex, length, etc) without inspecting devtools.
      if (Array.isArray(j.issues) && j.issues.length > 0) {
        const detail = j.issues
          .map((i) => {
            const p = Array.isArray(i.path) ? i.path.join(".") : "";
            return p ? `${p}: ${i.message ?? ""}` : (i.message ?? "");
          })
          .filter((s) => s.length > 0)
          .join("; ");
        if (detail) msg = `${msg} — ${detail}`;
      }
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      data-testid="button-copy-secret"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function EnterpriseTab() {
  const orgsQuery = useQuery({
    queryKey: ["v1-orgs"],
    queryFn: () => api<{ orgs: Org[] }>("/orgs"),
    retry: false,
  });

  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const orgs = orgsQuery.data?.orgs ?? [];

  useEffect(() => {
    if (!activeOrgId && orgs.length > 0) {
      setActiveOrgId(orgs[0]?.id ?? null);
    }
  }, [activeOrgId, orgs]);

  const [createSlug, setCreateSlug] = useState("");
  const [createName, setCreateName] = useState("");
  const [createReason, setCreateReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshSecret, setFreshSecret] = useState<{ org_id: string; value: string } | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/orgs", {
        method: "POST",
        body: JSON.stringify({
          slug: createSlug.trim(),
          display_name: createName.trim(),
          reason: createReason.trim(),
        }),
      });
      setCreateSlug("");
      setCreateName("");
      setCreateReason("");
      await orgsQuery.refetch();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Failed to create org");
    } finally {
      setBusy(false);
    }
  }

  async function rotateSecret(orgId: string) {
    setBusy(true);
    setError(null);
    try {
      const reason = window.prompt("Reason for rotating the enrollment secret:");
      if (!reason) {
        setBusy(false);
        return;
      }
      const r = await api<{ enrollment_secret: string }>(
        `/orgs/${orgId}/rotate-enrollment-secret`,
        { method: "POST", body: JSON.stringify({ reason }) },
      );
      setFreshSecret({ org_id: orgId, value: r.enrollment_secret });
      await orgsQuery.refetch();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Failed to rotate secret");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-800" data-testid="text-enterprise-error">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[14px]">
            <Building2 className="w-4 h-4" /> Organizations
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div>
              <Label htmlFor="org-slug" className="text-[11px]">Slug</Label>
              <Input id="org-slug" value={createSlug} onChange={(e) => setCreateSlug(e.target.value)} placeholder="acme" data-testid="input-org-slug" />
            </div>
            <div>
              <Label htmlFor="org-name" className="text-[11px]">Display name</Label>
              <Input id="org-name" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="Acme Corp" data-testid="input-org-name" />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="org-reason" className="text-[11px]">Reason (audited)</Label>
              <Input id="org-reason" value={createReason} onChange={(e) => setCreateReason(e.target.value)} placeholder="Pilot deployment with security team" data-testid="input-org-reason" />
            </div>
            <div className="md:col-span-4">
              <Button type="submit" disabled={busy || !createSlug || !createName || createReason.length < 3} data-testid="button-create-org">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                Create org
              </Button>
            </div>
          </form>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Has secret</TableHead>
                <TableHead>Created</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orgs.map((o) => (
                <TableRow
                  key={o.id}
                  className={activeOrgId === o.id ? "bg-secondary/40" : "cursor-pointer"}
                  onClick={() => setActiveOrgId(o.id)}
                  data-testid={`row-org-${o.slug}`}
                >
                  <TableCell className="font-mono text-[12px]">{o.slug}</TableCell>
                  <TableCell>{o.display_name}</TableCell>
                  <TableCell>{o.status}</TableCell>
                  <TableCell>{o.has_enrollment_secret ? "yes" : "no"}</TableCell>
                  <TableCell>{formatDate(o.created_at)}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); void rotateSecret(o.id); }} data-testid={`button-rotate-${o.slug}`}>
                      Rotate secret
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {orgs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground text-[12px] py-6">
                    No organizations yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {freshSecret && (
        <Card className="border-amber-300 bg-amber-50/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-[14px] text-amber-900">
              <ShieldCheck className="w-4 h-4" /> One-time enrollment secret
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-[12px] text-amber-900">
              Copy this now — it is shown once and never persisted in plaintext. Place it in
              <code className="font-mono bg-amber-100 px-1 mx-1 rounded">agent.config.json</code>
              under <code className="font-mono">org_enrollment_secret</code> on managed devices.
            </p>
            <div className="font-mono text-[12px] bg-white border border-amber-300 rounded px-3 py-2 break-all" data-testid="text-fresh-secret">
              {freshSecret.value}
            </div>
            <CopyButton value={freshSecret.value} />
          </CardContent>
        </Card>
      )}

      {activeOrgId && (
        <>
          <OrgPolicyLocks orgId={activeOrgId} />
          <OrgDevices orgId={activeOrgId} />
        </>
      )}
    </div>
  );
}

function OrgPolicyLocks({ orgId }: { orgId: string }) {
  const q = useQuery({
    queryKey: ["v1-org-policy-overrides", orgId],
    queryFn: () => api<{ overrides: PolicyOverride[] }>(`/orgs/${orgId}/policy-overrides`),
    retry: false,
  });

  const [path, setPath] = useState("");
  const [valueJson, setValueJson] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overrides = q.data?.overrides ?? [];
  const sorted = useMemo(
    () => [...overrides].sort((a, b) => a.policy_field_path.localeCompare(b.policy_field_path)),
    [overrides],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const parsed = JSON.parse(valueJson);
      await api(`/orgs/${orgId}/policy-overrides`, {
        method: "POST",
        body: JSON.stringify({
          policy_field_path: path.trim(),
          locked_value: parsed,
          reason: reason.trim(),
        }),
      });
      setPath("");
      setValueJson("");
      setReason("");
      await q.refetch();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Failed to set override");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[14px]">
          <Lock className="w-4 h-4" /> Policy locks
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-800">
            {error}
          </div>
        )}
        <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div>
            <Label className="text-[11px]">Field path</Label>
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="allowlist.scripts.signed_bos_scripts" data-testid="input-lock-path" />
          </div>
          <div>
            <Label className="text-[11px]">Locked value (JSON)</Label>
            <Textarea value={valueJson} onChange={(e) => setValueJson(e.target.value)} placeholder='["C:\\BOS-Omega\\scripts\\health-check.ps1"]' className="font-mono text-[12px] min-h-[60px]" data-testid="input-lock-value" />
          </div>
          <div>
            <Label className="text-[11px]">Reason (audited)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Restrict signed scripts to org-vetted set" data-testid="input-lock-reason" />
          </div>
          <div className="md:col-span-3">
            <Button type="submit" disabled={busy || !path || !valueJson || reason.length < 3} data-testid="button-set-lock">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
              Set lock
            </Button>
          </div>
        </form>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Field path</TableHead>
              <TableHead>Locked value</TableHead>
              <TableHead>Set by</TableHead>
              <TableHead>Set at</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((o) => (
              <TableRow key={o.id} data-testid={`row-lock-${o.policy_field_path}`}>
                <TableCell className="font-mono text-[12px]">{o.policy_field_path}</TableCell>
                <TableCell className="font-mono text-[11px] max-w-[400px] truncate">
                  {JSON.stringify(o.locked_value)}
                </TableCell>
                <TableCell className="font-mono text-[11px]">{o.set_by_user_id.slice(0, 8)}…</TableCell>
                <TableCell>{formatDate(o.set_at)}</TableCell>
              </TableRow>
            ))}
            {sorted.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground text-[12px] py-4">
                  No policy locks for this org.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function OrgDevices({ orgId }: { orgId: string }) {
  const q = useQuery({
    queryKey: ["v1-org-devices", orgId],
    queryFn: () => api<{ devices: OrgDevice[] }>(`/orgs/${orgId}/devices`),
    retry: false,
  });
  const devices = q.data?.devices ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[14px]">
          <Server className="w-4 h-4" /> Devices in org
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Display name</TableHead>
              <TableHead>Hostname</TableHead>
              <TableHead>Install mode</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Paired</TableHead>
              <TableHead>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {devices.map((d) => (
              <TableRow key={d.id} data-testid={`row-device-${d.id}`}>
                <TableCell>{d.display_name}</TableCell>
                <TableCell className="font-mono text-[11px]">{d.hostname ?? "—"}</TableCell>
                <TableCell className="font-mono text-[11px]">{d.install_mode}</TableCell>
                <TableCell>{d.status}</TableCell>
                <TableCell>{formatDate(d.paired_at)}</TableCell>
                <TableCell>{d.last_seen_at ? formatDate(d.last_seen_at) : "—"}</TableCell>
              </TableRow>
            ))}
            {devices.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground text-[12px] py-4">
                  No devices bound to this org yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// (Placeholder tabs removed during the 2026-08-08 audit — the
// operator requested no stub UI. Non-super-admin users now see an
// inline "Enterprise only" panel; super-admins land directly on
// the Enterprise tab which IS wired to /api/v1/orgs.)

export function LocalAgent() {
  const { data: auth } = useQuery({ queryKey: ["auth-state"], queryFn: fetchAuthState, retry: false });
  const role = auth?.authenticated ? auth.user.role : undefined;
  const isSuper = role === "super_admin";

  return (
    <div className="space-y-4">
      {isSuper ? (
        <Tabs defaultValue="enterprise">
          <TabsList>
            <TabsTrigger value="enterprise" data-testid="tab-enterprise">Enterprise</TabsTrigger>
          </TabsList>
          <TabsContent value="enterprise">
            <EnterpriseTab />
          </TabsContent>
        </Tabs>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-[14px] flex items-center gap-2">
              <Server className="w-4 h-4" />
              Local Agent — Enterprise Only
            </CardTitle>
            <CardDescription>
              The Local Agent surface is administered by your organization&apos;s
              super-admin. They manage org enrollment, device pairing, and
              per-org policy locks here. Non-admin operators do not see
              this surface.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-[12.5px] text-muted-foreground space-y-2">
            <p>
              If you need a paired Windows agent for this BOS-OMEGA
              workspace, ask your super-admin to generate a pair code
              from the <strong>Enterprise</strong> tab and share it
              with you. The pair code is a one-time 6-character token
              you paste into the agent installer.
            </p>
            <p>
              Per-device policy and per-org policy locks are
              super-admin-only operations. The agent installer honors
              whatever the super-admin locks at the org level.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
