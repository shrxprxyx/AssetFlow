"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Resource = { id: number; assetTag: string; name: string; location: string | null };
type Booking = {
  id: number;
  bookerId: number;
  startTime: string;
  endTime: string;
  purpose: string | null;
  booker: { firstName: string; lastName: string };
};

const HOURS = Array.from({ length: 9 }, (_, i) => 9 + i); // 9:00 .. 17:00

// Local calendar date (toISOString() would give the UTC date, which is
// yesterday/tomorrow for part of the day in timezones like IST).
function toLocalDateInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function BookingPage() {
  const { data: session } = useSession();
  const userId = Number(session?.user?.id);
  const isManager = session?.user?.role === "ADMIN" || session?.user?.role === "ASSET_MANAGER";

  const [resources, setResources] = useState<Resource[]>([]);
  const [resourceId, setResourceId] = useState<number | null>(null);
  const [date, setDate] = useState(toLocalDateInput(new Date()));
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [form, setForm] = useState({ start: "10:00", end: "11:00", purpose: "" });

  useEffect(() => {
    fetch("/api/resources")
      .then((r) => r.json())
      .then((d) => {
        setResources(d.resources ?? []);
        if (d.resources?.[0]) setResourceId(d.resources[0].id);
      });
  }, []);

  const refetch = () => {
    if (!resourceId) return;
    setLoading(true);
    fetch(`/api/bookings?resourceId=${resourceId}&date=${date}`)
      .then((r) => r.json())
      .then((d) => setBookings(d.bookings ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(refetch, [resourceId, date]);

  function bookingForHour(hour: number) {
    return bookings.find((b) => {
      const s = new Date(b.startTime).getHours();
      const e = new Date(b.endTime).getHours();
      return hour >= s && hour < e;
    });
  }

  // A booking can span several rows; show its Cancel button on the first visible one.
  function firstVisibleHour(b: Booking) {
    return Math.max(new Date(b.startTime).getHours(), HOURS[0]);
  }

  // You can cancel your own bookings (managers can cancel anyone's), as long as they haven't ended.
  function canCancel(b: Booking) {
    return (b.bookerId === userId || isManager) && new Date(b.endTime) > new Date();
  }

  async function submitBooking() {
    setError(null);
    setNotice(null);

    const start = new Date(`${date}T${form.start}:00`);
    const end = new Date(`${date}T${form.end}:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setError("Pick a valid date and start/end time.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceId,
          // Sent as exact instants, so the server doesn't have to guess our timezone.
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          purpose: form.purpose || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Booking conflict — slot is unavailable.");
        return;
      }
      setNotice("Booking confirmed.");
      setForm({ start: "10:00", end: "11:00", purpose: "" });
      refetch();
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelBooking(id: number) {
    setError(null);
    setNotice(null);
    setCancellingId(id);
    try {
      const res = await fetch(`/api/bookings/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message ?? "Could not cancel the booking.");
        return;
      }
      setNotice("Booking cancelled.");
      setConfirmId(null);
      refetch();
    } finally {
      setCancellingId(null);
    }
  }

  const selectedResource = resources.find((r) => r.id === resourceId);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Resource Booking</h1>
        <p className="text-sm text-muted-foreground">
          Pick a resource and date, then book an open hour on the grid below.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <select
          value={resourceId ?? ""}
          onChange={(e) => setResourceId(Number(e.target.value))}
          className="h-9 w-full cursor-pointer sm:w-auto rounded-lg border border-border bg-background px-3 text-sm text-foreground"
        >
          {resources.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} {r.location ? `— ${r.location}` : ""}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-9 w-full sm:w-auto rounded-lg border border-border bg-background px-3 text-sm text-foreground"
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        {loading && (
          <div className="p-3 text-sm text-muted-foreground">Loading schedule…</div>
        )}
        {!loading && HOURS.map((hour) => {
          const b = bookingForHour(hour);
          const showCancel = !!b && hour === firstVisibleHour(b) && canCancel(b);
          return (
            <div
              key={hour}
              className={cn(
                "flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0",
                b ? "bg-primary/15" : "bg-card"
              )}
            >
              <span className="w-14 sm:w-16 shrink-0 text-sm text-muted-foreground">
                {String(hour).padStart(2, "0")}:00
              </span>
              {b ? (
                <span className="text-sm text-foreground">
                  Booked — {b.purpose ?? "No purpose given"} ({b.booker.firstName} {b.booker.lastName})
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">Open</span>
              )}

              {showCancel && b && (
                <div className="ml-auto flex shrink-0 gap-1.5">
                  {confirmId === b.id ? (
                    <>
                      <Button
                        size="xs"
                        variant="destructive"
                        className="cursor-pointer"
                        disabled={cancellingId === b.id}
                        onClick={() => cancelBooking(b.id)}
                      >
                        {cancellingId === b.id ? "Cancelling…" : "Confirm cancel"}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        className="cursor-pointer"
                        disabled={cancellingId === b.id}
                        onClick={() => setConfirmId(null)}
                      >
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      className="cursor-pointer"
                      onClick={() => {
                        setError(null);
                        setNotice(null);
                        setConfirmId(b.id);
                      }}
                    >
                      Cancel booking
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!loading && bookings.length === 0 && (
          <div className="p-3 text-sm text-muted-foreground">
            No bookings for {selectedResource?.name ?? "this resource"} on this day.
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-dashed border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-400">
          {notice}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-1 w-full sm:w-auto">
          <label className="text-xs text-muted-foreground">Start</label>
          <input
            type="time"
            value={form.start}
            onChange={(e) => setForm({ ...form, start: e.target.value })}
            className="h-9 w-full sm:w-auto rounded-lg border border-border bg-background px-2 text-sm text-foreground"
          />
        </div>
        <div className="flex flex-col gap-1 w-full sm:w-auto">
          <label className="text-xs text-muted-foreground">End</label>
          <input
            type="time"
            value={form.end}
            onChange={(e) => setForm({ ...form, end: e.target.value })}
            className="h-9 w-full sm:w-auto rounded-lg border border-border bg-background px-2 text-sm text-foreground"
          />
        </div>
        <div className="flex flex-1 min-w-0 sm:min-w-40 flex-col gap-1 w-full sm:w-auto">
          <label className="text-xs text-muted-foreground">Purpose</label>
          <input
            type="text"
            value={form.purpose}
            onChange={(e) => setForm({ ...form, purpose: e.target.value })}
            placeholder="Weekly sync"
            className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
          />
        </div>
        <Button
          onClick={submitBooking}
          disabled={submitting || !resourceId}
          className="w-full sm:w-auto cursor-pointer"
        >
          {submitting ? "Booking…" : "Book"}
        </Button>
      </div>
    </div>
  );
}