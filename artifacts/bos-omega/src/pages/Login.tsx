import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock, ShieldCheck, KeyRound, Mail, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { login } from "@/lib/auth";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: async (creds: { email: string; password: string }) => {
      const result = await login(creds.email, creds.password);
      if (!result.ok) throw new Error(result.error);
      return result.user;
    },
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["auth-state"] });
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    mut.mutate({ email, password });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-lg bg-primary text-primary-foreground mb-4">
            <span className="font-serif font-bold text-xl">B</span>
          </div>
          <h1 className="font-serif text-2xl font-semibold text-foreground tracking-tight">
            BOS-Omega
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Orchestration platform — sign in
          </p>
        </div>

        <div className="bg-card border border-border rounded-lg shadow-card p-6">
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="text-sm font-medium text-foreground flex items-center gap-2 mb-2"
              >
                <Mail className="w-3.5 h-3.5 text-muted-foreground" />
                Email
              </label>
              <Input
                id="email"
                type="email"
                autoFocus
                autoComplete="username"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                disabled={mut.isPending}
                placeholder="you@example.com"
                data-testid="input-email"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="text-sm font-medium text-foreground flex items-center gap-2 mb-2"
              >
                <KeyRound className="w-3.5 h-3.5 text-muted-foreground" />
                Password
              </label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError(null);
                }}
                disabled={mut.isPending}
                placeholder="Enter your password"
                data-testid="input-password"
              />
            </div>

            {error && (
              <div
                className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-md px-3 py-2"
                role="alert"
                data-testid="text-login-error"
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={mut.isPending || !email || !password}
              className="w-full"
              data-testid="button-login"
            >
              {mut.isPending ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                  Signing in…
                </>
              ) : (
                <>
                  <Lock className="w-3.5 h-3.5 mr-2" />
                  Sign in
                </>
              )}
            </Button>
          </form>
        </div>

        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="w-3 h-3" />
          <span>
            Session protected with HttpOnly cookies, SameSite=Strict, AES-256-GCM at rest
          </span>
        </div>
      </div>
    </div>
  );
}
