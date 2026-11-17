"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/utils";
import type { Heatmap } from "@/utils/heatmap";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const RANGES = [7, 30, 90] as const;

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function BookingHeatmap() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [data, setData] = useState<Heatmap | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    setError(false);
    fetch(`/api/reports/heatmap?days=${days}&tz=${encodeURIComponent(tz)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: Heatmap) => !cancelled && setData(d))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [days]);

  const max = data ? Math.max(...data.cells.map((c) => c.utilisationPct), 1) : 1;
  // Show only the hours that have any bookings, plus the working day, so the grid isn't mostly empty.
  const hours = data
    ? Array.from({ length: 24 }, (_, h) => h).filter(
        (h) => (h >= 8 && h < 19) || data.cells.some((c) => c.hour === h && c.bookedHours > 0)
      )
    : [];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Booking Heatmap</CardTitle>
            <CardDescription>
              Share of bookable resource-hours that were booked, by weekday and hour
              {data ? ` (${data.timeZone})` : ""}
            </CardDescription>
          </div>
          <div className="flex gap-1" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <Button
                key={r}
                size="sm"
                variant={days === r ? "default" : "outline"}
                aria-pressed={days === r}
                onClick={() => setDays(r)}
              >
                {r} days
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-muted-foreground">Couldn&apos;t load the heatmap.</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : data.resourceCount === 0 ? (
          <p className="text-sm text-muted-foreground">No bookable resources yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-1 text-xs">
                <caption className="sr-only">Booking utilisation by weekday and hour</caption>
                <thead>
                  <tr>
                    <th scope="col" className="w-10" />
                    {hours.map((h) => (
                      <th key={h} scope="col" className="font-normal text-muted-foreground">
                        {String(h).padStart(2, "0")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DAY_NAMES.map((name, weekday) => (
                    <tr key={name}>
                      <th scope="row" className="pr-1 text-left font-normal text-muted-foreground">
                        {name}
                      </th>
                      {hours.map((h) => {
                        const c = data.cells[weekday * 24 + h];
                        const label = `${name} ${hourLabel(h)}: ${c.utilisationPct}% booked`;
                        return (
                          <td
                            key={h}
                            title={label}
                            aria-label={label}
                            className={cn("h-7 min-w-6 rounded-sm text-center", c.utilisationPct === 0 && "bg-muted")}
                            style={
                              c.utilisationPct > 0
                                ? { backgroundColor: `color-mix(in srgb, var(--primary) ${Math.round(15 + (c.utilisationPct / max) * 85)}%, transparent)` }
                                : undefined
                            }
                          />
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {data.busiest
                ? `Busiest: ${DAY_NAMES[data.busiest.weekday]} ${hourLabel(data.busiest.hour)} (${data.busiest.utilisationPct}% booked). `
                : "No bookings in this period. "}
              {data.totalBookedHours} booked hours across {data.resourceCount} resource
              {data.resourceCount === 1 ? "" : "s"}. The window ends yesterday.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
