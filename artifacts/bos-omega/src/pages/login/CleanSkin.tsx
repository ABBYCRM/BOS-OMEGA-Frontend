import type { LoginSkinProps } from "./types";

export function CleanSkin(props: LoginSkinProps) {
  const {
    mode,
    onModeChange,
    email,
    onEmailChange,
    password,
    onPasswordChange,
    confirm,
    onConfirmChange,
    error,
    isPending,
    onSubmit,
    onSwitchSkin,
  } = props;

  const clearError = () => {
    /* errors auto-clear on input change in the container */
  };

  return (
    <div className="min-h-screen w-full flex flex-col bg-background text-foreground">
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center mb-10">
            <div
              aria-hidden
              className="w-10 h-10 rounded-md bg-primary text-primary-foreground flex items-center justify-center font-semibold text-lg mb-4 shadow-sm"
            >
              Ω
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">
              BOS · Omega
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {mode === "signin"
                ? "Sign in to your workspace"
                : "Create your account"}
            </p>
          </div>

          <div
            role="tablist"
            className="grid grid-cols-2 mb-6 rounded-md bg-muted p-1 text-sm"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "signin"}
              data-testid="tab-signin"
              onClick={() => onModeChange("signin")}
              className={
                "py-1.5 rounded transition-colors " +
                (mode === "signin"
                  ? "bg-background shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "signup"}
              data-testid="tab-signup"
              onClick={() => onModeChange("signup")}
              className={
                "py-1.5 rounded transition-colors " +
                (mode === "signup"
                  ? "bg-background shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              Create account
            </button>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <CleanField
              id="email"
              label="Email"
              placeholder="you@example.com"
              type="email"
              value={email}
              onChange={onEmailChange}
              disabled={isPending}
              clearError={clearError}
              autoFocus
              autoComplete="username"
              testid="input-email"
            />
            <CleanField
              id="password"
              label="Password"
              placeholder={
                mode === "signup" ? "At least 8 characters" : "Your password"
              }
              type="password"
              value={password}
              onChange={onPasswordChange}
              disabled={isPending}
              clearError={clearError}
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
              testid="input-password"
            />
            {mode === "signup" && (
              <CleanField
                id="confirm"
                label="Confirm password"
                placeholder="Re-enter password"
                type="password"
                value={confirm}
                onChange={onConfirmChange}
                disabled={isPending}
                clearError={clearError}
                autoComplete="new-password"
                testid="input-confirm"
              />
            )}

            {error && (
              <div
                role="alert"
                data-testid="text-login-error"
                className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded px-3 py-2"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={
                isPending ||
                !email ||
                !password ||
                (mode === "signup" && !confirm)
              }
              data-testid={mode === "signin" ? "button-login" : "button-signup"}
              className="w-full py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {isPending
                ? mode === "signin"
                  ? "Signing in…"
                  : "Creating account…"
                : mode === "signin"
                  ? "Sign in"
                  : "Create account"}
            </button>

            <p className="text-xs text-muted-foreground text-center pt-2">
              {mode === "signin"
                ? "By signing in you agree to our terms of use."
                : "New accounts start with standard access."}
            </p>
          </form>
        </div>
      </main>

      <footer className="px-4 py-3 flex justify-end">
        <button
          type="button"
          onClick={onSwitchSkin}
          data-testid="button-switch-skin"
          aria-label="Switch login appearance"
          className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground tracking-wide transition-colors"
        >
          switch theme
        </button>
      </footer>
    </div>
  );
}

function CleanField(props: {
  id: string;
  label: string;
  placeholder: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  clearError: () => void;
  autoFocus?: boolean;
  autoComplete?: string;
  testid: string;
}) {
  return (
    <div>
      <label
        htmlFor={props.id}
        className="block text-sm font-medium text-foreground mb-1.5"
      >
        {props.label}
      </label>
      <input
        id={props.id}
        type={props.type}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
          props.clearError();
        }}
        disabled={props.disabled}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        autoComplete={props.autoComplete}
        data-testid={props.testid}
        className="w-full rounded-md border border-input bg-background text-foreground text-sm px-3 py-2 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-shadow disabled:opacity-50"
      />
    </div>
  );
}
