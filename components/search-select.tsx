"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

type SearchSelectProps<T extends { id: number }> = {
  /** A list endpoint that answers { data, total } and understands ?q= and ?pageSize=. */
  endpoint: string;
  /** Extra filters, e.g. { status: "ALLOCATED" }. */
  params?: Record<string, string>;
  /** Hide results the caller can't use (the server has already filtered what it can). */
  filter?: (item: T) => boolean;
  value: T | null;
  onChange: (item: T | null) => void;
  label: (item: T) => string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
};

const RESULTS = 20;
const DEBOUNCE_MS = 250;

/**
 * A search box that finds rows on the server as you type, for lists that can
 * grow past what a plain <select> should hold. Shows the first 20 matches and
 * says so when there are more; typing narrows them.
 */
export function SearchSelect<T extends { id: number }>({
  endpoint,
  params,
  filter,
  value,
  onChange,
  label,
  placeholder = "Search…",
  className,
  disabled,
}: SearchSelectProps<T>) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);

  // Search while the list is open; the box waits a moment after the last keystroke.
  const paramsKey = JSON.stringify(params ?? {});
  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      setFailed(false);
      try {
        const qs = new URLSearchParams({ ...(params ?? {}), pageSize: String(RESULTS) });
        if (text.trim()) qs.set("q", text.trim());
        const res = await fetch(`${endpoint}?${qs}`);
        const body = await res.json();
        if (!res.ok) throw new Error("search failed");
        if (mine !== seq.current) return; // a newer search has started
        setItems(body.data ?? []);
        setTotal(body.total ?? 0);
        setActive(0);
      } catch {
        if (mine === seq.current) {
          setItems([]);
          setFailed(true);
        }
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, text ? DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text, endpoint, paramsKey]);

  // Close when the user clicks elsewhere.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function close() {
    setOpen(false);
    setText("");
  }

  function pick(item: T) {
    onChange(item);
    close();
  }

  const shown = filter ? items.filter(filter) : items;

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") return close();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(shown.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && shown[active]) {
      e.preventDefault();
      pick(shown[active]);
    }
  }

  return (
    <div ref={root} className={cn("relative", className)}>
      <input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        disabled={disabled}
        // Closed: show the chosen item. Open: show what is being typed.
        value={open ? text : value ? label(value) : ""}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setOpen(true);
          setText(e.target.value);
        }}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-lg border border-border bg-background px-3 pr-8 text-sm text-foreground disabled:opacity-60"
      />
      {value && !open && !disabled && (
        <button
          type="button"
          aria-label="Clear selection"
          onClick={() => onChange(null)}
          className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-popover text-sm shadow-md"
        >
          {loading && shown.length === 0 && <li className="px-3 py-2 text-muted-foreground">Searching…</li>}
          {failed && <li className="px-3 py-2 text-destructive">Could not search. Try again.</li>}
          {!loading && !failed && shown.length === 0 && (
            <li className="px-3 py-2 text-muted-foreground">No matches</li>
          )}
          {shown.map((item, i) => (
            <li
              key={item.id}
              role="option"
              aria-selected={value?.id === item.id}
              // mousedown, not click: the input would lose focus and close the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(item);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "cursor-pointer px-3 py-2 text-foreground",
                i === active && "bg-muted",
                value?.id === item.id && "font-medium"
              )}
            >
              {label(item)}
            </li>
          ))}
          {total > items.length && (
            <li className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              Showing the first {items.length} of {total}. Keep typing to narrow it down.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
