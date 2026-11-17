import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
 
/**
 * Format a date and time
 */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
 
/**
 * Check if a date is overdue (before today)
 */
export function isOverdue(date: Date | string): boolean {
  const d = typeof date === "string" ? new Date(date) : date;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
}
 
/**
 * Get the number of days until a date
 */
export function daysUntil(date: Date | string): number {
  const d = typeof date === "string" ? new Date(date) : date;
  const today = new Date();
  const diff = d.getTime() - today.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}
 
/**
 * Format an asset status as readable text
 */
export function formatAssetStatus(status: string): string {
  const statusMap: Record<string, string> = {
    AVAILABLE: "Available",
    ALLOCATED: "Allocated",
    RESERVED: "Reserved",
    UNDER_MAINTENANCE: "Under Maintenance",
    LOST: "Lost",
    RETIRED: "Retired",
    DISPOSED: "Disposed",
  };
  return statusMap[status] || status;
}
 
/**
 * Get color variant for an asset status badge
 */
export function getStatusColor(status: string): string {
  const colorMap: Record<string, string> = {
    AVAILABLE: "success",
    ALLOCATED: "info",
    RESERVED: "warning",
    UNDER_MAINTENANCE: "warning",
    LOST: "danger",
    RETIRED: "danger",
    DISPOSED: "danger",
  };
  return colorMap[status] || "default";
}
 
/**
 * Format a condition value as readable text
 */
export function formatCondition(condition: string): string {
  const conditionMap: Record<string, string> = {
    GOOD: "Good",
    FAIR: "Fair",
    POOR: "Poor",
  };
  return conditionMap[condition] || condition;
}
 
/**
 * Format a role as readable text
 */
export function formatRole(role: string): string {
  const roleMap: Record<string, string> = {
    ADMIN: "Administrator",
    ASSET_MANAGER: "Asset Manager",
    DEPARTMENT_HEAD: "Department Head",
    EMPLOYEE: "Employee",
  };
  return roleMap[role] || role;
}
 
/**
 * Check if user has permission for an action
 */
export function hasPermission(
  userRole: string,
  requiredRoles: string[]
): boolean {
  return requiredRoles.includes(userRole);
}
 
/**
 * Truncate a string to a maximum length
 */
export function truncate(str: string, length: number): string {
  return str.length > length ? str.substring(0, length) + "..." : str;
}
 
/**
 * Debounce a function
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}
 
/**
 * Format currency
 */
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "INR",
  }).format(amount);
}
 