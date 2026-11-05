"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";

const MAX_EDGE_PX = 2000;
const JPEG_QUALITY = 0.82;
const ACCEPT = "image/jpeg,image/png,image/webp";

export interface ReceiptUploadResult {
  receiptId: string;
  ocr: { status: string; jobId?: string };
}

export type ReceiptCapturePhase = "idle" | "busy" | "done" | "error";

export interface ReceiptCaptureStatus {
  phase: ReceiptCapturePhase;
  errorCode: string | null;
}

export interface ReceiptCaptureProps {
  eventId: string;
  onUploaded?: (result: ReceiptUploadResult) => void;
  /**
   * Reports every capture phase change (row 17). The embedding form uses it to
   * run its own status chip instead of the built-in status line.
   */
  onStatusChange?: (status: ReceiptCaptureStatus) => void;
  /** Set false when the parent renders its own status text. */
  showStatus?: boolean;
  disabled?: boolean;
  className?: string;
}

const UPLOAD_ERROR_MESSAGE: Record<string, string> = {
  RECEIPT_TOO_LARGE: "The photo is too large. Try a smaller one.",
  RECEIPT_UNSUPPORTED_TYPE: "That file is not a JPEG, PNG or WebP photo.",
  RECEIPT_UNPROCESSABLE: "We could not read that photo. Try another one.",
  EVENT_CLOSED: "This event is closed, receipts can no longer be added.",
  MISSING_FILE: "Choose a photo first.",
  INVALID_FORM: "Upload failed. Try again.",
};

const STATUS_BUSY = "Processing photo…";
const STATUS_DONE = "Receipt captured.";

/** Human copy for an upload error code; shared with the embedding form. */
export function receiptCaptureErrorMessage(code: string): string {
  return UPLOAD_ERROR_MESSAGE[code] ?? "Upload failed. Please try again.";
}

/**
 * The canvas re-encode applies EXIF orientation (so the stored photo matches
 * what the phone showed) and drops metadata the browser would forward.
 */
async function reencodeToJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const scale = Math.min(
      1,
      MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("CANVAS_UNAVAILABLE");
    }
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY);
    });
    if (!blob) {
      throw new Error("ENCODE_FAILED");
    }
    return blob;
  } finally {
    bitmap.close();
  }
}

export function ReceiptCapture({
  eventId,
  onUploaded,
  onStatusChange,
  showStatus = true,
  disabled = false,
  className,
}: ReceiptCaptureProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<ReceiptCapturePhase>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    const url = previewRef.current;
    return () => {
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  useEffect(() => {
    onStatusChange?.({ phase, errorCode });
  }, [phase, errorCode, onStatusChange]);

  const handleFile = useCallback(
    async (file: File) => {
      setPhase("busy");
      setErrorCode(null);
      let jpeg: Blob;
      try {
        jpeg = await reencodeToJpeg(file);
      } catch {
        setPhase("error");
        setErrorCode("RECEIPT_UNPROCESSABLE");
        return;
      }
      try {
        const form = new FormData();
        form.set("eventId", eventId);
        form.set("file", jpeg, "receipt.jpg");
        const response = await fetch("/api/receipts", {
          method: "POST",
          body: form,
        });
        if (!response.ok) {
          let code = "UPLOAD_FAILED";
          try {
            const payload = await response.json();
            if (typeof payload?.error === "string") {
              code = payload.error;
            }
          } catch {
            // keep the generic code when the body is not JSON
          }
          setPhase("error");
          setErrorCode(code);
          return;
        }
        const uploaded = (await response.json()) as ReceiptUploadResult;
        if (previewRef.current) {
          URL.revokeObjectURL(previewRef.current);
        }
        const url = URL.createObjectURL(jpeg);
        previewRef.current = url;
        setPreviewUrl(url);
        setPhase("done");
        onUploaded?.(uploaded);
      } catch {
        setPhase("error");
        setErrorCode("UPLOAD_FAILED");
      }
    },
    [eventId, onUploaded],
  );

  const statusMessage =
    phase === "busy"
      ? STATUS_BUSY
      : phase === "done"
        ? STATUS_DONE
        : phase === "error" && errorCode
          ? receiptCaptureErrorMessage(errorCode)
          : null;

  return (
    <div className={cx("flex flex-col gap-3", className)}>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        capture="environment"
        className="sr-only"
        disabled={disabled || phase === "busy"}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            void handleFile(file);
          }
        }}
      />
      <Button
        type="button"
        variant="secondary"
        size="lg"
        fullWidth
        disabled={disabled || phase === "busy"}
        loading={phase === "busy"}
        onClick={() => inputRef.current?.click()}
      >
        {phase === "done" ? "Replace receipt photo" : "Add receipt photo"}
      </Button>
      <div
        aria-live="polite"
        className={showStatus ? "min-h-6 text-sm" : "hidden"}
      >
        {statusMessage ? (
          <p
            className={cx(
              phase === "error"
                ? "font-medium text-danger"
                : "font-medium text-success",
            )}
          >
            {statusMessage}
          </p>
        ) : null}
      </div>
      {phase === "done" && previewUrl ? (
        // biome-ignore lint/performance/noImgElement: local blob URL preview; next/image is unavailable for dynamic object URLs
        <img
          src={previewUrl}
          alt="Captured receipt"
          className="w-full rounded-card border border-border object-contain"
        />
      ) : null}
    </div>
  );
}
