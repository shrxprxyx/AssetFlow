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

type NavItem = {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  // If set, only these roles see the item. Keep in sync with the API guards.
  roles?: string[];
};

type NavGroup = { label: string; items: NavItem[] };

const MANAGERS = ["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD"];

const NAV_GROUPS: NavGroup[] = [
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
      { label: "Audit Cycles", href: "/audits", icon: CheckSquare, roles: MANAGERS },
      { label: "Reports", href: "/reports", icon: FileText, roles: MANAGERS },
      { label: "Activity & Notifications", href: "/activity", icon: Clock },
    ],
  },
  {
    label: "Admin",
    items: [
      { label: "Organization Setup", href: "/org-setup", icon: Settings, roles: ["ADMIN"] },
    ],
  },
];

export function AppSidebar({ userRole = "EMPLOYEE" }: { userRole?: string }) {
  const pathname = usePathname();

  // Drop items the role can't use, then drop groups that end up empty.
  const groups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((item) => !item.roles || item.roles.includes(userRole)),
  })).filter((g) => g.items.length > 0);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-4 py-3">
        <span className="font-bold text-lg group-data-[collapsible=icon]:hidden">
          AssetFlow
        </span>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((group) => (
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
