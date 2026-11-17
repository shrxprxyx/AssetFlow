"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { assetLink } from "@/lib/qr";

type Props = {
  asset: { assetTag: string; name: string; location?: string | null };
  onClose: () => void;
};

// Printing hides everything except the label, so no pop-up window is needed.
const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  .qr-label, .qr-label * { visibility: visible !important; }
  .qr-label { position: fixed; left: 0; top: 0; border: 1px solid #000 !important; background: #fff !important; color: #000 !important; }
}`;

/** A printable label: the asset's tag and name with a QR code that opens it in AssetFlow. */
export function AssetQrDialog({ asset, onClose }: Props) {
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const link = assetLink(window.location.origin, asset.assetTag);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(link, { width: 320, margin: 1, errorCorrectionLevel: "M" })
      .then((url) => !cancelled && setImage(url))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [link]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <style>{PRINT_CSS}</style>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`QR label for ${asset.assetTag}`}
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-5 shadow-lg"
      >
        <div className="qr-label mx-auto flex w-64 flex-col items-center gap-2 rounded-lg border border-border bg-white p-4 text-center text-black">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt={`QR code for ${asset.assetTag}`} className="h-48 w-48" />
          ) : (
            <div className="flex h-48 w-48 items-center justify-center text-sm text-neutral-500">
              {failed ? "Could not make the QR code" : "Making QR code…"}
            </div>
          )}
          <p className="text-lg font-semibold tracking-wide">{asset.assetTag}</p>
          <p className="text-sm leading-tight">{asset.name}</p>
          {asset.location && <p className="text-xs text-neutral-600">{asset.location}</p>}
        </div>

        <p className="break-all text-center text-xs text-muted-foreground">{link}</p>
        {/localhost|127\.0\.0\.1/.test(window.location.host) && (
          <p className="text-center text-xs text-amber-600 dark:text-amber-400">
            This link points at localhost, so it will only open on this computer. Print labels from the real address.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" className="cursor-pointer" onClick={onClose}>
            Close
          </Button>
          <Button className="cursor-pointer" disabled={!image} onClick={() => window.print()}>
            Print label
          </Button>
        </div>
      </div>
    </div>
  );
}
