"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3, Settings, Package, ArrowRightLeft, Calendar,
  Wrench, CheckSquare, FileText, Clock,
} from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel,
  SidebarGroupContent, SidebarMenu, SidebarMenuItem, SidebarMenuButton,
  SidebarHeader, SidebarFooter, SidebarRail,
} from "@/components/ui/sidebar";

const NAV_GROUPS = [
  {
    label: "Overview",
    items: [{ label: "Dashboard", href: "/dashboard", icon: BarChart3 }],
  },
  {
    label: "Asset Management",
    items: [
      { label: "Asset Registry", href: "/assets", icon: Package },
      { label: "Allocation & Transfer", href: "/allocations", icon: ArrowRightLeft },
      { label: "Maintenance", href: "/maintenance", icon: Wrench },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Resource Booking", href: "/bookings", icon: Calendar },
      { label: "Audit Cycles", href: "/audits", icon: CheckSquare },
      { label: "Reports", href: "/reports", icon: FileText },
      { label: "Activity & Notifications", href: "/activity", icon: Clock },
    ],
  },
  {
    label: "Admin",
    adminOnly: true,
    items: [{ label: "Organization Setup", href: "/org-setup", icon: Settings }],
  },
];

export function AppSidebar({ userRole = "EMPLOYEE" }: { userRole?: string }) {
  const pathname = usePathname();
  const isAdmin = userRole === "ADMIN";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-4 py-3">
        <span className="font-bold text-lg group-data-[collapsible=icon]:hidden">
          AssetFlow
        </span>
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.filter((g) => !g.adminOnly || isAdmin).map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      render={<Link href={item.href} />}
                      isActive={pathname === item.href}
                      tooltip={item.label}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter />
      <SidebarRail />
    </Sidebar>
  );
}