"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { SignupForm } from "@/components/auth-forms";
import { authApi } from "@/lib/api-client";
import type { SignupInput } from "@/lib/schemas";

export default function SignupPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState("");

  async function handleSignup(data: SignupInput) {
    setIsLoading(true);
    try {
      // The API always creates role=EMPLOYEE regardless of what's submitted —
      // this form has no role field, matching "signup creates an Employee
      // account only".
      await authApi.signup(data);

      // The account can't sign in until the emailed link is opened.
      setSubmittedEmail(data.email);
    } finally {
      setIsLoading(false);
    }
  }

  if (submittedEmail) {
    return (
      <AuthShell title="Check your email" subtitle="One more step before you can sign in">
        <div className="space-y-4 text-sm text-neutral-300">
          <p>
            We sent a verification link to <strong className="text-white">{submittedEmail}</strong>. Open it, then sign in.
          </p>
          <p className="text-neutral-400">
            It expires after 24 hours. Didn&apos;t get it?{" "}
            <Link href="/verify-email" className="text-white underline-offset-4 hover:underline">
              Send a new link
            </Link>
            .
          </p>
          <Link href="/login" className="block text-center font-medium text-white underline-offset-4 hover:underline">
            Go to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create your account" subtitle="New accounts start as Employee — an admin assigns other roles">
      <SignupForm onSubmit={handleSignup} isLoading={isLoading} />
    </AuthShell>
  );
}
