"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * Photo picker: uploads the chosen file straight away and hands the saved
 * "/api/files/..." path to the form through onChange. "" means no photo.
 * The server re-checks type and size; the checks here only give quick feedback.
 */
export function PhotoField({
  value,
  onChange,
  label = "Photo (optional)",
  className,
}: {
  value: string;
  onChange: (url: string) => void;
  label?: string;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function pick(file: File | undefined) {
    if (!file) return;
    setError("");
    if (!TYPES.includes(file.type)) {
      setError("Choose a JPEG, PNG or WebP photo");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("Photos can be at most 5 MB");
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Upload failed");
      onChange(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-3">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className="h-12 w-12 rounded-lg border border-border object-cover" />
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept={TYPES.join(",")}
          aria-label={label}
          disabled={busy}
          onChange={(e) => pick(e.target.files?.[0])}
          className="block w-full text-sm text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-border file:bg-background file:px-3 file:py-2 file:text-sm file:text-foreground"
        />
        {value ? (
          <Button type="button" size="sm" variant="outline" className="cursor-pointer" onClick={() => onChange("")}>
            Remove
          </Button>
        ) : null}
      </div>
      {busy && <p className="mt-1 text-xs text-muted-foreground">Uploading…</p>}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
