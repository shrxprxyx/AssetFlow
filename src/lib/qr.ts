/**
 * QR labels for assets.
 *
 * The code on a label is an ordinary link to the assets page filtered to that
 * asset, so any phone camera can open it. The in-app scanner reads the same code.
 */

/** The link a label's QR code holds. */
export function assetLink(origin: string, assetTag: string): string {
  return `${origin.replace(/\/+$/, "")}/assets?tag=${encodeURIComponent(assetTag)}`;
}

/**
 * Pulls an asset tag out of whatever a scan returned: our link, or just the
 * tag typed as text (e.g. a plain barcode label). Returns null when it is
 * neither, so a stray QR code (a website, a Wi-Fi code) is not treated as a tag.
 */
export function tagFromScan(text: string): string | null {
  const value = text.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    const tag = url.searchParams.get("tag")?.trim();
    return url.pathname.replace(/\/+$/, "") === "/assets" && tag ? tag : null;
  } catch {
    // Not a URL: accept a bare tag such as AF-0001.
  }
  return /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(value) ? value : null;
}

/**
 * Where to go after signing in: only a path inside this app. Anything that
 * could send the person to another site ("//evil.com", "https://...", "/\evil")
 * falls back to the dashboard.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return fallback;
  const path = raw.split(/[?#]/)[0];
  // Don't bounce back to the sign-in pages.
  if (["/login", "/signup", "/forgot-password", "/reset-password"].includes(path)) return fallback;
  return raw;
}
