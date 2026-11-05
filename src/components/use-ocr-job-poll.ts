"use client";

import { useEffect, useRef, useState } from "react";

/** Bounded poll: ~60s before the caller falls back to manual entry. */
export const OCR_POLL_INTERVAL_MS = 1500;
export const OCR_POLL_MAX_ATTEMPTS = 40;

/** The parsed receipt values row 16 stores on a succeeded job. */
export interface OcrJobValues {
  amountMinor: number;
  currency: string;
  eventCurrency: string;
  currencyMismatch: boolean;
  date: string;
  merchant: string;
}

export type OcrPollStatus = "idle" | "pending" | "succeeded" | "failed";

export interface OcrPollState {
  status: OcrPollStatus;
  result: OcrJobValues | null;
}

interface OcrJobResponse {
  id: string;
  status: string;
  result: OcrJobValues | null;
  errorCode: string | null;
}

const IDLE_STATE: OcrPollState = { status: "idle", result: null };

/**
 * Polls GET /api/ocr-jobs/[id] on a bounded interval until the job reaches a
 * terminal status or the attempt budget runs out. The interval is cleared on
 * unmount and when the job id changes, so a stale poll never resolves into a
 * component that is gone. `onResult` is read through a ref, so passing an
 * inline closure does not restart the poll.
 */
export function useOcrJobPoll(options: {
  jobId: string | null;
  onResult?: (result: OcrJobValues) => void;
}): OcrPollState {
  const { jobId, onResult } = options;
  const [state, setState] = useState<OcrPollState>(IDLE_STATE);
  const onResultRef = useRef(onResult);

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    if (jobId === null) {
      setState(IDLE_STATE);
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ status: "pending", result: null });

    const tick = async () => {
      if (cancelled) {
        return;
      }
      attempts += 1;
      let terminal = false;
      try {
        const response = await fetch(`/api/ocr-jobs/${jobId}`, {
          cache: "no-store",
        });
        if (cancelled) {
          return;
        }
        if (response.ok) {
          const job = (await response.json()) as OcrJobResponse;
          if (cancelled) {
            return;
          }
          if (job.status === "succeeded" && job.result) {
            onResultRef.current?.(job.result);
            setState({ status: "succeeded", result: job.result });
            terminal = true;
          } else if (job.status === "failed") {
            setState({ status: "failed", result: null });
            terminal = true;
          }
        }
      } catch {
        // A transient failure keeps the bounded poll going.
      }
      if (cancelled || terminal) {
        return;
      }
      if (attempts >= OCR_POLL_MAX_ATTEMPTS) {
        if (!cancelled) {
          setState({ status: "failed", result: null });
        }
        return;
      }
      timer = setTimeout(() => {
        void tick();
      }, OCR_POLL_INTERVAL_MS);
    };

    timer = setTimeout(() => {
      void tick();
    }, OCR_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [jobId]);

  return state;
}
