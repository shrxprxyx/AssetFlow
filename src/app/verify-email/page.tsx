import { AuthShell } from "@/components/auth-shell";
import { VerifyEmailPanel } from "@/components/auth-forms";

// The link in the signup email is /verify-email?token=...
// With no token this page offers to send a new link.
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;

  return (
    <AuthShell title="Verify your email" subtitle="Confirm your address to finish setting up your account">
      <VerifyEmailPanel token={typeof token === "string" ? token : ""} />
    </AuthShell>
  );
}
