"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

type PagerProps = {
  /** Current page, starting at 1. */
  page: number;
  pageSize: number;
  /** Total rows matching the current filters (the API's `total`). */
  total: number;
  onPageChange: (page: number) => void;
  /** Disable the buttons while a page is loading. */
  disabled?: boolean;
  /** What is being counted, e.g. "assets". */
  noun?: string;
};

/**
 * "Showing 26–50 of 137 assets" with Previous / Next buttons.
 * Works with any endpoint that answers { data, total, page, pageSize }.
 * Renders nothing when there are no rows; hides the buttons on a single page.
 */
export function Pager({ page, pageSize, total, onPageChange, disabled = false, noun = "results" }: PagerProps) {
  if (total <= 0) return null;

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  const from = (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
    >
      <p aria-live="polite">
        Showing {from}–{to} of {total} {noun}
      </p>

      {pageCount > 1 && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            disabled={disabled || current <= 1}
            onClick={() => onPageChange(current - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <span className="whitespace-nowrap px-1">
            Page {current} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            disabled={disabled || current >= pageCount}
            onClick={() => onPageChange(current + 1)}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </nav>
  );
}
