import { redirect } from "next/navigation";

// The root URL just forwards into the app. The protected layout sends
// signed-out users to /login.
export default function Home() {
  redirect("/dashboard");
}
