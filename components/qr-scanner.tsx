"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (options: { formats: string[] }) => Detector;

type Props = {
  /** Called once with the text of the first QR code seen. */
  onResult: (text: string) => void;
  onClose: () => void;
};

/**
 * Opens the camera and reads a QR code with the browser's built-in
 * BarcodeDetector (Chrome and Android). Elsewhere it explains the alternative:
 * a label is an ordinary link, so the phone's own camera app opens it.
 */
export function QrScanner({ onResult, onClose }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    if (!Ctor) {
      setMessage("This browser can't scan QR codes. Scan the label with your phone's camera app instead: it opens the asset directly.");
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setMessage("The camera only works on a secure (https) address, or on localhost.");
      return;
    }

    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then(async (s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const el = video.current;
        if (!el) return;
        el.srcObject = s;
        await el.play();

        const detector = new Ctor({ formats: ["qr_code"] });
        let busy = false;
        timer = setInterval(async () => {
          if (busy || stopped || el.readyState < 2) return;
          busy = true;
          try {
            const [code] = await detector.detect(el);
            if (code?.rawValue && !stopped) {
              stopped = true;
              onResult(code.rawValue);
            }
          } catch {
            /* a frame that can't be read is not an error: try the next one */
          } finally {
            busy = false;
          }
        }, 250);
      })
      .catch((e: unknown) => {
        const name = (e as { name?: string })?.name;
        setMessage(
          name === "NotAllowedError"
            ? "Camera access was blocked. Allow it in the browser's site settings and try again."
            : name === "NotFoundError"
              ? "No camera was found on this device."
              : "Could not start the camera."
        );
      });

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // onResult is only used when a code is found; re-running would restart the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Scan a QR label"
        className="w-full max-w-sm space-y-3 rounded-xl border border-border bg-card p-5 shadow-lg"
      >
        <h2 className="text-lg font-semibold text-foreground">Scan an asset label</h2>
        {message ? (
          <p className="text-sm text-muted-foreground">{message}</p>
        ) : (
          <>
            <video ref={video} muted playsInline className="aspect-square w-full rounded-lg bg-black object-cover" />
            <p className="text-xs text-muted-foreground">Hold the label in front of the camera.</p>
          </>
        )}
        <div className="flex justify-end">
          <Button variant="outline" className="cursor-pointer" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
