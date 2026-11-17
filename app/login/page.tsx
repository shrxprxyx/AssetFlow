"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/auth-forms";
import type { LoginInput } from "@/lib/schemas";
import { safeNextPath } from "@/lib/qr";

export default function LoginPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  // LoginForm shows whatever message this throws under the form.
  async function handleLogin(data: LoginInput) {
    setIsLoading(true);
    try {
      const res = await signIn("credentials", {
        email: data.email,
        password: data.password,
        redirect: false,
      });

      if (res?.error) {
        // next-auth sets code to "rate_limited" when the server refused too many attempts.
        if (res.code === "rate_limited") {
          throw new Error("Too many sign-in attempts. Please wait a few minutes and try again.");
        }
        if (res.code === "email_not_verified") {
          throw new Error(
            "Your email isn't verified yet. Open the link we emailed you, or go to /verify-email to get a new one."
          );
        }
        throw new Error("Invalid email or password");
      }

      // Back to the page that sent us here (e.g. a scanned QR label), if it was inside this app.
      const next = new URLSearchParams(window.location.search).get("callbackUrl");
      router.push(safeNextPath(next));
      router.refresh();
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your AssetFlow account">
      <LoginForm onSubmit={handleLogin} isLoading={isLoading} />
    </AuthShell>
  );
}
