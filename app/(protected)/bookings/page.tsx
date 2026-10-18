"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Resource = { id: number; assetTag: string; name: string; location: string | null };
type Booking = {
  id: number;
  startTime: string;
  endTime: string;
  purpose: string | null;
  booker: { firstName: string; lastName: string };
};

const HOURS = Array.from({ length: 9 }, (_, i) => 9 + i); // 9:00 .. 17:00

function toLocalDateInput(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function BookingPage() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [resourceId, setResourceId] = useState<number | null>(null);
  const [date, setDate] = useState(toLocalDateInput(new Date()));
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
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

  async function submitBooking() {
    setError(null);
    setSubmitting(true);
    try {
      const startTime = `${date}T${form.start}:00`;
      const endTime = `${date}T${form.end}:00`;
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceId,
          startTime,
          endTime,
          purpose: form.purpose || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Booking conflict — slot is unavailable.");
        return;
      }
      setForm({ start: "10:00", end: "11:00", purpose: "" });
      refetch();
    } finally {
      setSubmitting(false);
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