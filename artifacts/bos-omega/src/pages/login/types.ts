import type { FormEvent } from "react";

export type LoginMode = "signin" | "signup";

export type LoginSkinProps = {
  mode: LoginMode;
  onModeChange: (mode: LoginMode) => void;

  email: string;
  onEmailChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  confirm: string;
  onConfirmChange: (value: string) => void;

  error: string | null;
  isPending: boolean;
  glitch: boolean;

  onSubmit: (e: FormEvent) => void;

  onSwitchSkin: () => void;
};
