"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/auth-forms";
import type { LoginInput } from "@/lib/schemas";

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
        throw new Error("Invalid email or password");
      }

      router.push("/dashboard");
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
