const API_URL = process.env.NEXT_PUBLIC_API_URL || "/api";

interface ApiErrorResponse {
  error?: string;
  [key: string]: any;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public data: ApiErrorResponse,
    message?: string
  ) {
    // Prefer the backend's actual message/error code over a generic string -
    // this is what makes signup's inline Zod errors, the allocation conflict
    // banner, etc. show real text instead of "API Error: 400" everywhere.
    super(message || data.message || data.error || "API Error");
    this.name = "ApiError";
  }
}

async function apiCall<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    credentials: "include",
  });

  let data: any;
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new ApiError(response.status, data);
  }

  return data as T;
}

// ── Auth Endpoints ──────────────────────────────────
export const authApi = {
  signup: async (payload: {
    email: string;
    firstName: string;
    lastName: string;
    password: string;
  }) => {
    return apiCall("/auth/signup", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  login: async (payload: { email: string; password: string }) => {
    return apiCall("/auth/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  getMe: async () => {
    return apiCall("/auth/me", { method: "GET" });
  },

  logout: async () => {
    return apiCall("/auth/logout", { method: "POST" });
  },
};

// ── Department Endpoints ────────────────────────────
export const departmentApi = {
  list: async () => {
    const data = await apiCall("/departments", { method: "GET" });
    return Array.isArray(data) ? data : data.data || [];
  },

  create: async (payload: any) => {
    return apiCall("/departments", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  update: async (id: number, payload: any) => {
    return apiCall(`/departments/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },

  delete: async (id: number) => {
    return apiCall(`/departments/${id}`, { method: "DELETE" });
  },
};

// ── Asset Category Endpoints ────────────────────────
export const assetCategoryApi = {
  list: async () => {
    const data = await apiCall("/asset-categories", { method: "GET" });
    return Array.isArray(data) ? data : data.data || [];
  },

  create: async (payload: any) => {
    return apiCall("/asset-categories", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  update: async (id: number, payload: any) => {
    return apiCall(`/asset-categories/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },
};

// ── Asset Endpoints ─────────────────────────────────
export const assetApi = {
  list: async (query?: Record<string, any>) => {
    const params = new URLSearchParams();
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      });
    }
    const data = await apiCall(`/assets?${params}`, { method: "GET" });
    return {
      data: Array.isArray(data) ? data : data.data || [],
      total: data.total || 0,
    };
  },

  get: async (id: number) => {
    return apiCall(`/assets/${id}`, { method: "GET" });
  },

  create: async (payload: any) => {
    return apiCall("/assets", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  update: async (id: number, payload: any) => {
    return apiCall(`/assets/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },
};

// ── Allocation Endpoints ────────────────────────────
export const allocationApi = {
  list: async (query?: Record<string, any>) => {
    const params = new URLSearchParams();
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      });
    }
    const data = await apiCall(`/allocations?${params}`, { method: "GET" });
    return Array.isArray(data) ? data : data.data || [];
  },

  create: async (payload: any) => {
    return apiCall("/allocations", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  return: async (id: number, payload: any) => {
    return apiCall(`/allocations/${id}/return`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};

// ── Transfer Request Endpoints ──────────────────────
export const transferApi = {
  create: async (payload: any) => {
    // Real route is /allocations/transfer, not /transfers - and transfers
    // auto-approve per the build plan (no manual approval step was built),
    // so this single call is the whole flow.
    return apiCall("/allocations/transfer", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  // No backing route exists for these two - transfers aren't listed
  // separately (they resolve straight into an Allocation record, visible
  // via allocationApi.list / AssetHistory), and there's no manual-approve
  // endpoint since transfers auto-approve. Left as TODOs rather than
  // removed, in case a real approval step gets added later.
  list: async () => {
    throw new Error("transferApi.list has no backing route - transfers auto-approve, use allocationApi.list instead");
  },

  approve: async (_id: number) => {
    throw new Error("transferApi.approve has no backing route - transfers auto-approve on create");
  },
};

// ── User/Employee Endpoints ────────────────────────
export const employeeApi = {
  list: async () => {
    const data = await apiCall("/employees", { method: "GET" });
    return Array.isArray(data) ? data : data.data || [];
  },

  promote: async (id: number, role: string) => {
    return apiCall(`/employees/${id}/promote`, {
      method: "POST",
      body: JSON.stringify({ role }),
    });
  },
};

// ── Booking Endpoints ────────────────────────────────
export const bookingApi = {
  list: async (resourceId?: number) => {
    const params = new URLSearchParams();
    if (resourceId) params.append("resourceId", String(resourceId));
    const data = await apiCall(`/bookings?${params}`, { method: "GET" });
    return Array.isArray(data) ? data : data.data || [];
  },

  create: async (payload: any) => {
    return apiCall("/bookings", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};

// ── Maintenance Endpoints ────────────────────────────
export const maintenanceApi = {
  list: async (status?: string) => {
    const params = new URLSearchParams();
    if (status) params.append("status", status);
    const data = await apiCall(`/maintenance-requests?${params}`, { method: "GET" });
    return Array.isArray(data) ? data : data.data || [];
  },

  create: async (payload: any) => {
    return apiCall("/maintenance-requests", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  updateStatus: async (id: number, status: string) => {
    return apiCall(`/maintenance-requests/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  },
};

// ── Audit Endpoints ────────────────────────────────
export const auditApi = {
  createCycle: async (payload: any) => {
    return apiCall("/audit-cycles", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  listCycles: async () => {
    const data = await apiCall("/audit-cycles", { method: "GET" });
    return Array.isArray(data) ? data : data.data || [];
  },

  getCycle: async (cycleId: number) => {
    return apiCall(`/audit-cycles/${cycleId}`, { method: "GET" });
  },

  // Real route is nested under the cycle (PATCH, not POST) and needs
  // cycleId in the path - the finding record has no meaning outside a cycle.
  recordFinding: async (cycleId: number, payload: any) => {
    return apiCall(`/audit-cycles/${cycleId}/findings`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  closeCycle: async (cycleId: number) => {
    return apiCall(`/audit-cycles/${cycleId}/close`, {
      method: "POST",
    });
  },
};

// ── Activity Log Endpoints ──────────────────────────
export const activityApi = {
  list: async () => {
    const data = await apiCall("/activity", { method: "GET" });
    return Array.isArray(data) ? data : data.data || [];
  },
};