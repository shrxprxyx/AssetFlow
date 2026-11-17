"use client";

import React, { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2, Lock, Mail, User } from "lucide-react";
import { z } from "zod";
import {
  forgotPasswordSchema,
  loginSchema,
  signupSchema,
  type ForgotPasswordInput,
  type LoginInput,
  type SignupInput,
} from "@/lib/schemas";

/* ───────────────────────── shared building blocks ───────────────────────── */

type IconType = React.ComponentType<{ className?: string }>;

type FieldProps = React.ComponentProps<"input"> & {
  label: string;
  icon: IconType;
  error?: string;
  hint?: string;
};

// `ref` is a normal prop in React 19, so react-hook-form's register() can be
// spread straight onto this component.
function Field({ label, icon: Icon, error, hint, type = "text", ...props }: FieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const isPassword = type === "password";

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-neutral-300">
        {label}
      </label>

      <div className="relative">
        <Icon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />

        <input
          id={id}
          type={isPassword && visible ? "text" : type}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={`h-11 w-full rounded-xl border bg-neutral-900/80 pl-10 ${
            isPassword ? "pr-11" : "pr-4"
          } text-sm text-white outline-none transition placeholder:text-neutral-600 focus:border-white/40 focus:ring-4 focus:ring-white/10 ${
            error ? "border-red-500/60" : "border-white/10 hover:border-white/20"
          }`}
          {...props}
        />

        {isPassword && (
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Hide password" : "Show password"}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-neutral-500 transition hover:bg-white/5 hover:text-neutral-200"
          >
            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>

      {error ? (
        <p id={`${id}-error`} className="mt-1.5 flex items-center gap-1 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-neutral-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
      <span>{message}</span>
    </div>
  );
}

function SuccessAlert({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200"
    >
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
      <span>{message}</span>
    </div>
  );
}

function BackToSignIn() {
  return (
    <p className="pt-1 text-center text-sm text-neutral-400">
      <Link href="/login" className="font-medium text-white underline-offset-4 transition hover:underline">
        Back to sign in
      </Link>
    </p>
  );
}

function SubmitButton({
  loading,
  loadingText,
  children,
}: {
  loading: boolean;
  loadingText: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="flex h-11 w-full items-center cursor-pointer justify-center gap-2 rounded-xl bg-white text-sm font-semibold text-neutral-950 shadow-lg shadow-black/30 transition hover:bg-neutral-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {loading ? loadingText : children}
    </button>
  );
}

/* ───────────────────────────────── Login ───────────────────────────────── */

interface LoginFormProps {
  onSubmit: (data: LoginInput) => Promise<void>;
  isLoading?: boolean;
}

export function LoginForm({ onSubmit, isLoading = false }: LoginFormProps) {
  const [apiError, setApiError] = useState<string>("");
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmitForm = async (data: LoginInput) => {
    try {
      setApiError("");
      await onSubmit(data);
    } catch (err: any) {
      setApiError(err.message || "Login failed");
    }
  };

  const busy = isLoading || isSubmitting;

  return (
    <form onSubmit={handleSubmit(onSubmitForm)} className="space-y-5" noValidate>
      {apiError && <ErrorAlert message={apiError} />}

      <Field
        label="Email"
        icon={Mail}
        type="email"
        placeholder="you@company.com"
        autoComplete="email"
        error={errors.email?.message}
        {...register("email")}
      />

      <Field
        label="Password"
        icon={Lock}
        type="password"
        placeholder="Enter your password"
        autoComplete="current-password"
        error={errors.password?.message}
        {...register("password")}
      />

      <div className="-mt-2 text-right">
        <Link
          href="/forgot-password"
          className="text-sm text-neutral-400 underline-offset-4 transition hover:text-white hover:underline"
        >
          Forgot password?
        </Link>
      </div>

      <SubmitButton loading={busy} loadingText="Signing in...">
        Sign in
      </SubmitButton>

      <p className="pt-1 text-center text-sm text-neutral-400">
        Don&apos;t have an account?{" "}
        <Link
          href="/signup"
          className="font-medium text-white underline-offset-4 transition hover:underline"
        >
          Create one
        </Link>
      </p>
    </form>
  );
}

/* ───────────────────────────────── Signup ───────────────────────────────── */

interface SignupFormProps {
  onSubmit: (data: SignupInput) => Promise<void>;
  isLoading?: boolean;
}

export function SignupForm({ onSubmit, isLoading = false }: SignupFormProps) {
  const [apiError, setApiError] = useState<string>("");
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
  });

  const onSubmitForm = async (data: SignupInput) => {
    try {
      setApiError("");
      await onSubmit(data);
    } catch (err: any) {
      setApiError(err.message || "Signup failed");
    }
  };

  const busy = isLoading || isSubmitting;

  return (
    <form onSubmit={handleSubmit(onSubmitForm)} className="space-y-5" noValidate>
      {apiError && <ErrorAlert message={apiError} />}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="First name"
          icon={User}
          placeholder="Priya"
          autoComplete="given-name"
          error={errors.firstName?.message}
          {...register("firstName")}
        />
        <Field
          label="Last name"
          icon={User}
          placeholder="Shah"
          autoComplete="family-name"
          error={errors.lastName?.message}
          {...register("lastName")}
        />
      </div>

      <Field
        label="Work email"
        icon={Mail}
        type="email"
        placeholder="you@company.com"
        autoComplete="email"
        error={errors.email?.message}
        {...register("email")}
      />

      <Field
        label="Password"
        icon={Lock}
        type="password"
        placeholder="Create a password"
        autoComplete="new-password"
        hint="At least 8 characters."
        error={errors.password?.message}
        {...register("password")}
      />

      <SubmitButton loading={busy} loadingText="Creating account...">
        Create account
      </SubmitButton>

      <p className="pt-1 text-center text-sm text-neutral-400">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium text-white underline-offset-4 transition hover:underline"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}

/* ──────────────────────────── Forgot password ──────────────────────────── */

export function ForgotPasswordForm() {
  const [apiError, setApiError] = useState("");
  const [sentMessage, setSentMessage] = useState("");
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
  });

  const onSubmitForm = async (data: ForgotPasswordInput) => {
    setApiError("");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || "Could not send the reset link");
      setSentMessage(body.message || "If an account exists for that email, a reset link has been sent.");
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Could not send the reset link");
    }
  };

  // The same message is shown whether or not the address has an account.
  if (sentMessage) {
    return (
      <div className="space-y-5">
        <SuccessAlert message={sentMessage} />
        <p className="text-sm text-neutral-400">
          The link works once and expires after 30 minutes. Check your spam folder if it doesn&apos;t arrive.
        </p>
        <BackToSignIn />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmitForm)} className="space-y-5" noValidate>
      {apiError && <ErrorAlert message={apiError} />}

      <Field
        label="Email"
        icon={Mail}
        type="email"
        placeholder="you@company.com"
        autoComplete="email"
        error={errors.email?.message}
        {...register("email")}
      />

      <SubmitButton loading={isSubmitting} loadingText="Sending...">
        Send reset link
      </SubmitButton>

      <BackToSignIn />
    </form>
  );
}

/* ───────────────────────────── Reset password ───────────────────────────── */

const newPasswordSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Type the password again"),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "The two passwords don't match",
    path: ["confirmPassword"],
  });
type NewPasswordInput = z.infer<typeof newPasswordSchema>;

export function ResetPasswordForm({ token }: { token: string }) {
  const [apiError, setApiError] = useState("");
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordInput>({
    resolver: zodResolver(newPasswordSchema),
  });

  const onSubmitForm = async (data: NewPasswordInput) => {
    setApiError("");
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: data.password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || "Could not reset the password");
      setDone(true);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Could not reset the password");
    }
  };

  if (!token) {
    return (
      <div className="space-y-5">
        <ErrorAlert message="This reset link is incomplete. Request a new one." />
        <p className="text-center text-sm text-neutral-400">
          <Link
            href="/forgot-password"
            className="font-medium text-white underline-offset-4 transition hover:underline"
          >
            Request a new link
          </Link>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-5">
        <SuccessAlert message="Your password has been changed. You can sign in now." />
        <BackToSignIn />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmitForm)} className="space-y-5" noValidate>
      {apiError && <ErrorAlert message={apiError} />}

      <Field
        label="New password"
        icon={Lock}
        type="password"
        placeholder="Create a new password"
        autoComplete="new-password"
        hint="At least 8 characters."
        error={errors.password?.message}
        {...register("password")}
      />

      <Field
        label="Confirm new password"
        icon={Lock}
        type="password"
        placeholder="Type it again"
        autoComplete="new-password"
        error={errors.confirmPassword?.message}
        {...register("confirmPassword")}
      />

      <SubmitButton loading={isSubmitting} loadingText="Saving...">
        Change password
      </SubmitButton>

      <p className="pt-1 text-center text-sm text-neutral-400">
        Link expired?{" "}
        <Link
          href="/forgot-password"
          className="font-medium text-white underline-offset-4 transition hover:underline"
        >
          Request a new one
        </Link>
      </p>
    </form>
  );
}

/* ───────────────────────────── email verification ───────────────────────────── */

export function ResendVerificationForm({ defaultEmail = "" }: { defaultEmail?: string }) {
  const [apiError, setApiError] = useState("");
  const [sentMessage, setSentMessage] = useState("");
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: defaultEmail },
  });

  const onSubmitForm = async (data: ForgotPasswordInput) => {
    setApiError("");
    try {
      const res = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || "Could not send the link");
      setSentMessage(body.message || "If that account still needs verifying, a new link has been sent.");
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Could not send the link");
    }
  };

  if (sentMessage) {
    return (
      <div className="space-y-5">
        <SuccessAlert message={sentMessage} />
        <p className="text-sm text-neutral-400">The link expires after 24 hours. Check your spam folder if it doesn&apos;t arrive.</p>
        <BackToSignIn />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmitForm)} className="space-y-5" noValidate>
      {apiError && <ErrorAlert message={apiError} />}
      <Field
        label="Email"
        icon={Mail}
        type="email"
        placeholder="you@company.com"
        autoComplete="email"
        error={errors.email?.message}
        {...register("email")}
      />
      <SubmitButton loading={isSubmitting} loadingText="Sending...">
        Send a new link
      </SubmitButton>
      <BackToSignIn />
    </form>
  );
}

/**
 * With a token: a button that confirms the address. It is a button, not
 * automatic, because mail scanners open links to check them, and that would use
 * up a single-use link before the person ever clicked it.
 * Without a token: the form for asking for a new link.
 */
export function VerifyEmailPanel({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "working" | "done" | "failed">("idle");
  const [message, setMessage] = useState("");

  if (!token) return <ResendVerificationForm />;

  async function confirm() {
    setState("working");
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await res.json().catch(() => ({}));
      setMessage(body.message || (res.ok ? "Your email is verified." : "Could not verify the email"));
      setState(res.ok ? "done" : "failed");
    } catch {
      setMessage("Could not verify the email. Check your connection and try again.");
      setState("failed");
    }
  }

  if (state === "done") {
    return (
      <div className="space-y-5">
        <SuccessAlert message={message} />
        <BackToSignIn />
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className="space-y-5">
        <ErrorAlert message={message} />
        <ResendVerificationForm />
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={confirm}
        disabled={state === "working"}
        className="flex w-full items-center justify-center rounded-xl bg-white px-4 py-3 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:opacity-60"
      >
        {state === "working" ? "Verifying..." : "Confirm my email"}
      </button>
      <BackToSignIn />
    </div>
  );
}
