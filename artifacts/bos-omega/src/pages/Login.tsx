import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { login, signup, type AuthUser } from "@/lib/auth";
import { CleanSkin } from "./login/CleanSkin";
import { UmbrellaSkin } from "./login/UmbrellaSkin";
import type { LoginMode, LoginSkinProps } from "./login/types";

type Skin = "clean" | "umbrella";

const SKIN_STORAGE_KEY = "bos:loginSkin";

// Default is the Umbrella Corporation skin — every fresh visitor sees
// it, regardless of role. Anyone who prefers the minimalist look can
// flip to "clean" via the in-page "switch theme" / "// STANDARD MODE"
// button; that choice is persisted in localStorage and respected on
// subsequent loads. The skin is intentionally NOT changed by login —
// the user's manual preference always wins, so signing in does not
// override it.
function readStoredSkin(): Skin {
  if (typeof window === "undefined") return "umbrella";
  try {
    const raw = window.localStorage.getItem(SKIN_STORAGE_KEY);
    return raw === "clean" ? "clean" : "umbrella";
  } catch {
    return "umbrella";
  }
}

function writeStoredSkin(skin: Skin) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SKIN_STORAGE_KEY, skin);
  } catch {
    /* localStorage can throw in private mode / quota — silent ignore is fine */
  }
}

export function Login() {
  const [skin, setSkin] = useState<Skin>(readStoredSkin);
  const [mode, setMode] = useState<LoginMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [glitch, setGlitch] = useState(false);
  const qc = useQueryClient();

  // Keep the in-memory choice synced to storage so a page reload after
  // a manual toggle preserves the new skin too.
  useEffect(() => {
    writeStoredSkin(skin);
  }, [skin]);

  const flashGlitch = () => {
    setGlitch(true);
    window.setTimeout(() => setGlitch(false), 600);
  };

  const onAuthSuccess = (_user: AuthUser) => {
    setError(null);
    // The user's manual skin preference always wins — login does not
    // override it. Just refresh the auth-state query so the rest of the
    // app picks up the new session.
    void qc.invalidateQueries({ queryKey: ["auth-state"] });
  };

  const loginMut = useMutation({
    mutationFn: async (creds: { email: string; password: string }) => {
      const result = await login(creds.email, creds.password);
      if (!result.ok) throw new Error(result.error);
      return result.user;
    },
    onSuccess: onAuthSuccess,
    onError: (err: Error) => {
      setError(err.message);
      flashGlitch();
    },
  });

  const signupMut = useMutation({
    mutationFn: async (creds: { email: string; password: string }) => {
      const result = await signup(creds.email, creds.password);
      if (!result.ok) throw new Error(result.error);
      return result.user;
    },
    onSuccess: onAuthSuccess,
    onError: (err: Error) => {
      setError(err.message);
      flashGlitch();
    },
  });

  const isPending = loginMut.isPending || signupMut.isPending;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    if (mode === "signup") {
      if (password.length < 8) {
        setError("Password must be at least 8 characters.");
        flashGlitch();
        return;
      }
      if (password !== confirm) {
        setError("Passwords do not match.");
        flashGlitch();
        return;
      }
      signupMut.mutate({ email, password });
    } else {
      loginMut.mutate({ email, password });
    }
  };

  const onModeChange = (next: LoginMode) => {
    setMode(next);
    setError(null);
    setConfirm("");
  };

  // When email/password/confirm change in the skin, drop any stale error
  // so the user isn't yelled at while they're typing the fix.
  const wrapInput = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    if (error) setError(null);
  };

  const onSwitchSkin = () => {
    setSkin((s) => (s === "umbrella" ? "clean" : "umbrella"));
  };

  const skinProps: LoginSkinProps = {
    mode,
    onModeChange,
    email,
    onEmailChange: wrapInput(setEmail),
    password,
    onPasswordChange: wrapInput(setPassword),
    confirm,
    onConfirmChange: wrapInput(setConfirm),
    error,
    isPending,
    glitch,
    onSubmit,
    onSwitchSkin,
  };

  return skin === "umbrella" ? (
    <UmbrellaSkin {...skinProps} />
  ) : (
    <CleanSkin {...skinProps} />
  );
}
