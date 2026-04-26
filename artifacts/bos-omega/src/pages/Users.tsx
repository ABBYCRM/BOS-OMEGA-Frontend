import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListUsers,
  useCreateUser,
  useUpdateUser,
  useResetUserPassword,
  getListUsersQueryKey,
} from "@workspace/api-client-react";
import { fetchAuthState } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";
import { Users as UsersIcon, KeyRound, UserPlus, Loader2, Copy, Check } from "lucide-react";

type Role = "user" | "admin" | "super_admin";
type Status = "active" | "disabled";

const roleLabels: Record<Role, string> = {
  user: "User",
  admin: "Admin",
  super_admin: "Super Admin",
};

function RolePill({ role }: { role: string }) {
  const tone =
    role === "super_admin"
      ? "border-amber-300 bg-amber-50 text-amber-800"
      : role === "admin"
        ? "border-blue-300 bg-blue-50 text-blue-800"
        : "border-border bg-secondary text-foreground";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10.5px] font-mono uppercase tracking-wider rounded border ${tone}`}>
      {roleLabels[role as Role] ?? role}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const isActive = status === "active";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10.5px] font-mono uppercase tracking-wider rounded border ${
        isActive
          ? "border-green-300 bg-green-50 text-green-800"
          : "border-red-300 bg-red-50 text-red-800"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-green-600" : "bg-red-600"}`} />
      {status}
    </span>
  );
}

export function Users() {
  const qc = useQueryClient();
  const { data: auth } = useQuery({ queryKey: ["auth-state"], queryFn: fetchAuthState, retry: false });
  const me = auth?.authenticated ? auth.user : undefined;

  const { data, isLoading, error } = useListUsers({
    query: { queryKey: getListUsersQueryKey() },
  });

  const invalidateUsers = () =>
    qc.invalidateQueries({ queryKey: getListUsersQueryKey() });

  const createMut = useCreateUser({
    mutation: { onSuccess: () => invalidateUsers() },
  });
  const updateMut = useUpdateUser({
    mutation: { onSuccess: () => invalidateUsers() },
  });
  const resetMut = useResetUserPassword({
    mutation: { onSuccess: () => invalidateUsers() },
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [tempPasswordModal, setTempPasswordModal] = useState<{ email: string; password: string } | null>(null);
  // Every mutating action against a user account requires a typed reason
  // that lands in the audit log. We collect it through a single dialog so
  // the operator always knows why they're changing something.
  const [reasonModal, setReasonModal] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: (reason: string) => Promise<void>;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [reasonBusy, setReasonBusy] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);

  // Create form state
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<Role>("user");
  const [newReason, setNewReason] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const closeReason = () => {
    setReasonModal(null);
    setReason("");
    setReasonBusy(false);
    setReasonError(null);
  };

  const submitReason = async () => {
    if (!reasonModal) return;
    setReasonError(null);
    setReasonBusy(true);
    try {
      await reasonModal.onConfirm(reason.trim());
      closeReason();
    } catch (e) {
      setReasonBusy(false);
      setReasonError((e as { data?: { error?: string } })?.data?.error || (e as Error).message || "Action failed");
    }
  };

  const onCreate = async () => {
    setCreateError(null);
    try {
      await createMut.mutateAsync({
        data: { email: newEmail, password: newPassword, role: newRole, reason: newReason.trim() },
      });
      setNewEmail("");
      setNewPassword("");
      setNewRole("user");
      setNewReason("");
      setCreateOpen(false);
    } catch (e) {
      const msg = (e as { message?: string; status?: number; data?: { error?: string } })?.data?.error
        || (e as Error).message
        || "Failed to create user";
      setCreateError(msg);
    }
  };

  const onChangeRole = (id: string, email: string, fromRole: Role, toRole: Role) => {
    setReasonModal({
      title: `Change role for ${email}`,
      description: `Role will change from ${roleLabels[fromRole]} to ${roleLabels[toRole]}. This is recorded in the audit log with your reason.`,
      confirmLabel: "Change role",
      onConfirm: async (reasonText) => {
        await updateMut.mutateAsync({ id, data: { role: toRole, reason: reasonText } });
      },
    });
  };

  const onToggleStatus = (id: string, email: string, currentStatus: Status) => {
    const next: Status = currentStatus === "active" ? "disabled" : "active";
    setReasonModal({
      title: `${next === "disabled" ? "Disable" : "Enable"} ${email}`,
      description: `The account will be ${next}. This is recorded in the audit log with your reason.`,
      confirmLabel: next === "disabled" ? "Disable account" : "Enable account",
      onConfirm: async (reasonText) => {
        await updateMut.mutateAsync({ id, data: { status: next, reason: reasonText } });
      },
    });
  };

  const onResetPassword = (id: string, email: string) => {
    setReasonModal({
      title: `Reset password for ${email}`,
      description: "A one-time temporary password will be shown after you confirm. The reason is recorded in the audit log.",
      confirmLabel: "Reset password",
      onConfirm: async (reasonText) => {
        const res = await resetMut.mutateAsync({ id, data: { reason: reasonText } });
        const tp = (res as { temporary_password?: string }).temporary_password;
        if (tp) setTempPasswordModal({ email, password: tp });
      },
    });
  };

  if (me && me.role !== "super_admin") {
    return (
      <div className="bg-card border border-card-border rounded-lg p-6">
        <h2 className="text-base font-semibold text-foreground mb-2">Forbidden</h2>
        <p className="text-sm text-muted-foreground">User management is restricted to super admins.</p>
      </div>
    );
  }

  const users = data?.users ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <UsersIcon className="w-4 h-4 text-primary" />
        <h1 className="text-xl font-serif font-semibold text-foreground tracking-tight">Users</h1>
        <span className="text-[11px] font-mono text-muted-foreground">({users.length})</span>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="button-create-user">
            <UserPlus className="w-3.5 h-3.5 mr-2" /> New user
          </Button>
        </div>
      </div>

      {isLoading && <div className="text-xs font-mono text-muted-foreground">Loading users...</div>}
      {error && (
        <div className="text-xs font-mono text-red-700">
          Failed to load users: {(error as { data?: { error?: string } })?.data?.error || "unknown error"}
        </div>
      )}

      {!isLoading && !error && (
        <div className="bg-card border border-card-border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b border-border bg-secondary">
            <div className="grid grid-cols-12 gap-3 text-[10px] font-mono text-muted-foreground tracking-wider">
              <span className="col-span-3">EMAIL</span>
              <span className="col-span-2">ROLE</span>
              <span className="col-span-2">STATUS</span>
              <span className="col-span-2">LAST LOGIN</span>
              <span className="col-span-3 text-right">ACTIONS</span>
            </div>
          </div>
          <div className="divide-y divide-border/30">
            {users.length === 0 ? (
              <div className="p-6 text-center text-xs font-mono text-muted-foreground">No users yet.</div>
            ) : (
              users.map((u) => {
                const isMe = u.id === me?.id;
                return (
                  <div key={u.id} className="px-4 py-3 hover:bg-muted/10 transition-colors" data-testid={`row-user-${u.id}`}>
                    <div className="grid grid-cols-12 gap-3 items-center">
                      <div className="col-span-3 text-sm font-mono text-foreground truncate" title={u.email}>
                        {u.email}
                        {isMe && <span className="ml-2 text-[10px] text-muted-foreground">(you)</span>}
                      </div>
                      <div className="col-span-2">
                        <Select
                          value={u.role}
                          onValueChange={(v) => {
                            const next = v as Role;
                            if (next === u.role) return;
                            onChangeRole(u.id, u.email, u.role as Role, next);
                          }}
                          disabled={isMe || updateMut.isPending}
                        >
                          <SelectTrigger className="h-7 text-xs" data-testid={`select-role-${u.id}`}>
                            <SelectValue>{<RolePill role={u.role} />}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="user">User</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="super_admin">Super Admin</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="col-span-2">
                        <StatusPill status={u.status} />
                      </div>
                      <div className="col-span-2 text-[11px] font-mono text-muted-foreground">
                        {u.last_login_at ? formatDate(u.last_login_at) : "—"}
                      </div>
                      <div className="col-span-3 flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onResetPassword(u.id, u.email)}
                          disabled={resetMut.isPending}
                          data-testid={`button-reset-password-${u.id}`}
                        >
                          <KeyRound className="w-3 h-3 mr-1" /> Reset
                        </Button>
                        <Button
                          size="sm"
                          variant={u.status === "active" ? "outline" : "default"}
                          onClick={() => onToggleStatus(u.id, u.email, u.status as Status)}
                          disabled={isMe || updateMut.isPending}
                          data-testid={`button-toggle-${u.id}`}
                        >
                          {u.status === "active" ? "Disable" : "Enable"}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Create User dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create user</DialogTitle>
            <DialogDescription>Choose an email, initial password, and role.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-mono text-muted-foreground mb-1 block">Email</label>
              <Input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="user@example.com"
                data-testid="input-new-email"
              />
            </div>
            <div>
              <label className="text-xs font-mono text-muted-foreground mb-1 block">Initial password</label>
              <Input
                type="text"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 8 characters"
                data-testid="input-new-password"
              />
            </div>
            <div>
              <label className="text-xs font-mono text-muted-foreground mb-1 block">Role</label>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as Role)}>
                <SelectTrigger data-testid="select-new-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="super_admin">Super Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-mono text-muted-foreground mb-1 block">
                Reason (required, ≥3 chars — recorded in audit log)
              </label>
              <Input
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
                placeholder="Why are you creating this account?"
                data-testid="input-new-reason"
              />
            </div>
            {createError && (
              <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">{createError}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={onCreate}
              disabled={
                createMut.isPending
                || !newEmail
                || newPassword.length < 8
                || newReason.trim().length < 3
              }
              data-testid="button-submit-create"
            >
              {createMut.isPending ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reason capture for role change / status toggle / reset password */}
      <Dialog open={reasonModal !== null} onOpenChange={(v) => !v && closeReason()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reasonModal?.title}</DialogTitle>
            <DialogDescription>{reasonModal?.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-mono text-muted-foreground mb-1 block">
                Reason (required, ≥3 chars)
              </label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why are you doing this?"
                data-testid="input-action-reason"
              />
            </div>
            {reasonError && (
              <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">{reasonError}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeReason}>Cancel</Button>
            <Button
              onClick={submitReason}
              disabled={reasonBusy || reason.trim().length < 3}
              data-testid="button-confirm-reason"
            >
              {reasonBusy ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : null}
              {reasonModal?.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time temporary password modal */}
      <TempPasswordModal data={tempPasswordModal} onClose={() => setTempPasswordModal(null)} />
    </div>
  );
}

function TempPasswordModal({
  data,
  onClose,
}: {
  data: { email: string; password: string } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={!!data} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Temporary password</DialogTitle>
          <DialogDescription>
            One-time password for <span className="font-mono">{data?.email}</span>. It will not be shown again.
            Send it to the user securely; they should change it after signing in.
          </DialogDescription>
        </DialogHeader>
        <div className="bg-secondary border border-border rounded p-3 font-mono text-sm break-all" data-testid="text-temp-password">
          {data?.password}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              if (!data?.password) return;
              try {
                await navigator.clipboard.writeText(data.password);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                // noop
              }
            }}
          >
            {copied ? <Check className="w-3.5 h-3.5 mr-2" /> : <Copy className="w-3.5 h-3.5 mr-2" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
