"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { AuthShell } from "@/components/auth-shell";
import { SignupForm } from "@/components/auth-forms";
import { authApi } from "@/lib/api-client";
import type { SignupInput } from "@/lib/schemas";

export default function SignupPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  async function handleSignup(data: SignupInput) {
    setIsLoading(true);
    try {
      // The API always creates role=EMPLOYEE regardless of what's submitted —
      // this form has no role field, matching "signup creates an Employee
      // account only".
      await authApi.signup(data);

      // Auto-login so the person lands on the dashboard instead of being
      // bounced back to a form they just filled out.
      const res = await signIn("credentials", {
        email: data.email,
        password: data.password,
        redirect: false,
      });

      if (res?.error) {
        router.push("/login");
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <AuthShell title="Create your account" subtitle="New accounts start as Employee — an admin assigns other roles">
      <SignupForm onSubmit={handleSignup} isLoading={isLoading} />
    </AuthShell>
  );
}
