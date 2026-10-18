"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
  EmptyState,
  LoadingState,
  Badge,
} from "@/components/ui";
import { activityApi, ApiError } from "@/lib/api-client";
import { formatDateTime } from "@/lib/utils";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface ActivityLog {
  id: number;
  action: string;
  resourceType?: string;
  resourceId?: number;
  actorId?: number;
  actor?: { firstName: string; lastName: string };
  timestamp: string;
  changes?: Record<string, any>;
}

const ACTION_LABELS: Record<string, { label: string; variant: string }> = {
  ASSET_ALLOCATED: { label: "Asset Allocated", variant: "info" },
  ASSET_RETURNED: { label: "Asset Returned", variant: "success" },
  ASSET_REGISTERED: { label: "Asset Registered", variant: "info" },
  ALLOCATION_CREATED: { label: "Allocation Created", variant: "info" },
  ALLOCATION_RETURNED: { label: "Allocation Returned", variant: "success" },
  TRANSFER_REQUESTED: { label: "Transfer Requested", variant: "warning" },
  TRANSFER_APPROVED: { label: "Transfer Approved", variant: "success" },
  TRANSFER_REJECTED: { label: "Transfer Rejected", variant: "danger" },
  MAINTENANCE_RAISED: { label: "Maintenance Raised", variant: "warning" },
  MAINTENANCE_APPROVED: { label: "Maintenance Approved", variant: "success" },
  MAINTENANCE_REJECTED: { label: "Maintenance Rejected", variant: "danger" },
  MAINTENANCE_RESOLVED: { label: "Maintenance Resolved", variant: "success" },
  BOOKING_CREATED: { label: "Booking Created", variant: "info" },
  BOOKING_CANCELLED: { label: "Booking Cancelled", variant: "danger" },
  AUDIT_CYCLE_CREATED: { label: "Audit Started", variant: "warning" },
  AUDIT_CYCLE_CLOSED: { label: "Audit Closed", variant: "success" },
  AUDIT_FINDING_RECORDED: { label: "Audit Finding", variant: "warning" },
  EMPLOYEE_PROMOTED: { label: "Employee Promoted", variant: "success" },
  DEPARTMENT_CREATED: { label: "Department Created", variant: "info" },
};

const FILTER_TABS = [
  { value: "ALL", label: "All Activity" },
  { value: "ALERTS", label: "Alerts" },
  { value: "APPROVALS", label: "Approvals" },
  { value: "BOOKINGS", label: "Bookings" },
];

export default function ActivityPage() {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [filter, setFilter] = useState<string>("ALL");

  useEffect(() => {
    const fetchActivity = async () => {
      try {
        setLoading(true);
        setError("");
        const data = await activityApi.list();
        setLogs(Array.isArray(data) ? data : data.data || []);
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.data.error || "Failed to load activity log");
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError("Failed to load activity log");
        }
      } finally {
        setLoading(false);
      }
    };

    fetchActivity();
  }, []);

  const filteredLogs =
    filter === "ALL"
      ? logs
      : logs.filter((log) => {
          if (filter === "ALERTS") {
            return [
              "TRANSFER_REJECTED",
              "MAINTENANCE_REJECTED",
              "BOOKING_CANCELLED",
              "ASSET_LOST",
            ].includes(log.action);
          }
          if (filter === "APPROVALS") {
            return log.action.includes("APPROVED") || log.action.includes("REJECTED");
          }
          if (filter === "BOOKINGS") {
            return log.action.includes("BOOKING");
          }
          return true;
        });

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-2">
          Activity & Notifications
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground">
          Complete audit log of all actions performed in the system
        </p>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2 flex-wrap">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer",
              filter === tab.value
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Activity Log */}
      <Card>
        <CardHeader>
          <CardTitle>Activity Log</CardTitle>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="p-3 mb-4 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm">
              {error}
            </div>
          )}

          {loading ? (
            <LoadingState message="Loading activity log..." />
          ) : filteredLogs.length === 0 ? (
            <EmptyState
              icon={<Clock size={40} />}
              title="No activity found"
              description={
                filter === "ALL"
                  ? "No actions have been logged yet"
                  : `No ${filter.toLowerCase()} activities found`
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Timestamp</TableHeaderCell>
                    <TableHeaderCell>Action</TableHeaderCell>
                    <TableHeaderCell>Actor</TableHeaderCell>
                    <TableHeaderCell>Resource</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLogs.map((log) => {
                    const actionInfo =
                      ACTION_LABELS[log.action] ||
                      ({
                        label: log.action.replace(/_/g, " "),
                        variant: "default",
                      } as any);

                    return (
                      <TableRow key={log.id}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatDateTime(log.timestamp)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={actionInfo.variant as any}>
                            {actionInfo.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {log.actor
                            ? `${log.actor.firstName} ${log.actor.lastName}`
                            : "System"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {log.resourceType && log.resourceId ? (
                            <span className="text-muted-foreground">
                              {log.resourceType} #{log.resourceId}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/60">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {!loading && filteredLogs.length > 0 && (
            <p className="text-xs text-muted-foreground mt-4">
              Showing {filteredLogs.length} of {logs.length} activities
            </p>
          )}
        </CardContent>
      </Card>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm mb-2">Total Activities</p>
            <p className="text-3xl font-bold text-foreground">{logs.length}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm mb-2">Approvals</p>
            <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">
              {logs.filter((l) => l.action.includes("APPROVED")).length}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm mb-2">Alerts</p>
            <p className="text-3xl font-bold text-amber-600 dark:text-amber-400">
              {logs.filter((l) =>
                [
                  "TRANSFER_REJECTED",
                  "MAINTENANCE_REJECTED",
                  "BOOKING_CANCELLED",
                ].includes(l.action)
              ).length}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}