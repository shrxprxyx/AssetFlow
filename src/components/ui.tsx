"use client";

import React, { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

// ── Card Component ──────────────────────────────────
interface CardProps {
  className?: string;
  children: ReactNode;
}

export function Card({ className, children }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-slate-700 bg-slate-900/50 backdrop-blur-sm p-6",
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: CardProps) {
  return (
    <div className={cn("mb-4", className)}>
      {children}
    </div>
  );
}

export function CardTitle({
  className,
  children,
}: CardProps & { children: ReactNode }) {
  return (
    <h2 className={cn("text-xl font-semibold text-white", className)}>
      {children}
    </h2>
  );
}

export function CardContent({ className, children }: CardProps) {
  return (
    <div className={cn("text-slate-200", className)}>
      {children}
    </div>
  );
}

// ── Button Component ────────────────────────────────
interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: ButtonProps) {
  const baseClasses =
    "font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

  const variantClasses = {
    primary: "bg-blue-600 hover:bg-blue-700 text-white",
    secondary: "bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700",
    danger: "bg-red-900/30 hover:bg-red-900/50 text-red-300 border border-red-700",
    ghost: "text-slate-300 hover:bg-slate-800/50",
  };

  const sizeClasses = {
    sm: "px-3 py-1 text-sm",
    md: "px-4 py-2 text-sm",
    lg: "px-6 py-3 text-base",
  };

  return (
    <button
      className={cn(
        baseClasses,
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// ── Table Component ─────────────────────────────────
interface TableProps {
  className?: string;
  children: ReactNode;
}

export function Table({ className, children }: TableProps) {
  return (
    <div className="overflow-x-auto border border-slate-700 rounded-lg">
      <table className={cn("w-full", className)}>
        {children}
      </table>
    </div>
  );
}

export function TableHeader({ className, children }: TableProps) {
  return (
    <thead className={cn("bg-slate-800 border-b border-slate-700", className)}>
      {children}
    </thead>
  );
}

export function TableBody({ className, children }: TableProps) {
  return (
    <tbody className={cn("divide-y divide-slate-700", className)}>
      {children}
    </tbody>
  );
}

interface TableRowProps extends TableProps {
  hover?: boolean;
}

export function TableRow({ className, children, hover = true }: TableRowProps) {
  return (
    <tr
      className={cn(
        "bg-slate-900/30",
        hover && "hover:bg-slate-800/50",
        className
      )}
    >
      {children}
    </tr>
  );
}

interface TableCellProps extends TableProps {
  align?: "left" | "center" | "right";
}

export function TableCell({ className, children, align = "left" }: TableCellProps) {
  return (
    <td
      className={cn(
        "px-4 py-3 text-sm text-slate-200",
        align === "center" && "text-center",
        align === "right" && "text-right",
        className
      )}
    >
      {children}
    </td>
  );
}

export function TableHeaderCell({
  className,
  children,
  align = "left",
}: TableCellProps) {
  return (
    <th
      className={cn(
        "px-4 py-3 text-xs font-semibold text-slate-300 uppercase tracking-wider",
        align === "center" && "text-center",
        align === "right" && "text-right",
        className
      )}
    >
      {children}
    </th>
  );
}

// ── Dialog Component ────────────────────────────────
interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

export function Dialog({ open, onOpenChange, children }: DialogProps) {
  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={() => onOpenChange(false)}
      />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        {children}
      </div>
    </>
  );
}

interface DialogContentProps {
  className?: string;
  children: ReactNode;
  onClose?: () => void;
}

export function DialogContent({
  className,
  children,
  onClose,
}: DialogContentProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-slate-700 bg-slate-900 shadow-lg max-w-md w-full max-h-[90vh] overflow-y-auto",
        className
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {onClose && (
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-200 z-10"
        >
          <X size={20} />
        </button>
      )}
      {children}
    </div>
  );
}

export function DialogHeader({ className, children }: CardProps) {
  return (
    <div className={cn("px-6 py-4 border-b border-slate-700", className)}>
      {children}
    </div>
  );
}

export function DialogTitle({
  className,
  children,
}: CardProps & { children: ReactNode }) {
  return (
    <h3 className={cn("text-lg font-semibold text-white", className)}>
      {children}
    </h3>
  );
}

export function DialogBody({ className, children }: CardProps) {
  return (
    <div className={cn("px-6 py-4", className)}>
      {children}
    </div>
  );
}

export function DialogFooter({ className, children }: CardProps) {
  return (
    <div
      className={cn(
        "px-6 py-4 border-t border-slate-700 flex gap-2 justify-end",
        className
      )}
    >
      {children}
    </div>
  );
}

// ── Badge Component ─────────────────────────────────
interface BadgeProps {
  variant?: "default" | "success" | "warning" | "danger" | "info";
  className?: string;
  children: ReactNode;
}

export function Badge({ variant = "default", className, children }: BadgeProps) {
  const variantClasses = {
    default: "bg-slate-700 text-slate-200",
    success: "bg-green-900/30 text-green-300 border border-green-700",
    warning: "bg-yellow-900/30 text-yellow-300 border border-yellow-700",
    danger: "bg-red-900/30 text-red-300 border border-red-700",
    info: "bg-blue-900/30 text-blue-300 border border-blue-700",
  };

  return (
    <span
      className={cn(
        "inline-block px-3 py-1 rounded-full text-xs font-medium",
        variantClasses[variant],
        className
      )}
    >
      {children}
    </span>
  );
}

// ── Empty State Component ────────────────────────────
interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4">
      {icon && <div className="mb-4 text-slate-500 text-4xl">{icon}</div>}
      <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
      {description && (
        <p className="text-slate-400 text-sm mb-4">{description}</p>
      )}
      {action && <div>{action}</div>}
    </div>
  );
}

// ── Loading State Component ──────────────────────────
export function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center">
      <div className="w-8 h-8 border-4 border-slate-700 border-t-blue-600 rounded-full animate-spin" />
    </div>
  );
}

interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = "Loading..." }: LoadingStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-4">
      <LoadingSpinner />
      <p className="text-slate-400 text-sm">{message}</p>
    </div>
  );
}