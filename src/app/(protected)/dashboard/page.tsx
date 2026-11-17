"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { LoadingState } from "@/components/ui";

type DashboardData = {
  available: number;
  allocated: number;
  maintenanceToday: number;
  activeBookings: number;
  pendingTransfers: number;
  overdue: number;
  upcomingReturns: number;
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((res) => res.json())
      .then(setData);
  }, []);

  if (!data) return <LoadingState message="Loading dashboard..." />;

  const cards = [
    { label: "Available", value: data.available },
    { label: "Allocated", value: data.allocated },
    { label: "Maintenance Today", value: data.maintenanceToday },
    { label: "Active Bookings", value: data.activeBookings },
    { label: "Pending Transfers", value: data.pendingTransfers },
    { label: "Upcoming Returns", value: data.upcomingReturns },
  ];

  return (
    <div className="space-y-6 sm:space-y-8">
      <h1 className="text-2xl sm:text-3xl font-bold text-foreground">
        Today&apos;s Overview
      </h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">{c.label}</p>
              <p className="text-3xl font-bold text-foreground">{c.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {data.overdue > 0 && (
        <div className="border border-destructive/30 bg-destructive/10 rounded-lg p-4 text-destructive text-sm">
          {data.overdue} asset{data.overdue > 1 ? "s" : ""} overdue — flagged for follow-up
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
        <Link href="/assets" className={buttonVariants({ className: "w-full sm:w-auto justify-center" })}>
          + Register Asset
        </Link>
        <Link
          href="/bookings"
          className={buttonVariants({ variant: "secondary", className: "w-full sm:w-auto justify-center" })}
        >
          Book Resource
        </Link>
        <Link
          href="/maintenance"
          className={buttonVariants({ variant: "secondary", className: "w-full sm:w-auto justify-center" })}
        >
          Raise Request
        </Link>
      </div>
    </div>
  );
}