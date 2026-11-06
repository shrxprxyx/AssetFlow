"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Item = { id: number; type: string; message: string; isRead: boolean; createdAt: string };

const POLL_MS = 30000;

export function NotificationsBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const seenUnread = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.notifications ?? []);
      const count = data.unreadCount ?? 0;
      // Toast only for new arrivals, not the initial load.
      if (seenUnread.current !== null && count > seenUnread.current) {
        const newest = (data.notifications ?? []).find((n: Item) => !n.isRead);
        if (newest) toast.info(newest.message);
      }
      seenUnread.current = count;
      setUnread(count);
    } catch {
      /* network blip: try again on next poll */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function markAllRead() {
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    load();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button className="relative inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted">
            <Bell className="h-5 w-5" />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold flex items-center justify-center">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <Button variant="ghost" size="sm" onClick={markAllRead}>
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-sm text-muted-foreground text-center">No notifications yet</p>
          ) : (
            items.map((n) => (
              <div
                key={n.id}
                className={`px-3 py-2 border-b last:border-b-0 text-sm ${n.isRead ? "text-muted-foreground" : "text-foreground bg-muted/40"}`}
              >
                <p>{n.message}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {new Date(n.createdAt).toLocaleString()}
                </p>
              </div>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
