import { z } from "zod";
import { isAcceptablePhotoUrl, PHOTO_URL_MESSAGE } from "./imageUpload";

/** An uploaded photo ("/api/files/...") or an http(s) link. */
export const photoUrlSchema = z.string().trim().refine(isAcceptablePhotoUrl, PHOTO_URL_MESSAGE);

// ── Auth Schemas ─────────────────────────────────────
export const signupSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email("Enter a valid email"),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Reset link is missing its token"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

// ── Employee/Promote Schema ───────────────────────────
// Deliberately excludes ADMIN — nobody can self-promote to Admin via this endpoint
export const promoteSchema = z.object({
  role: z.enum(["EMPLOYEE", "ASSET_MANAGER", "DEPARTMENT_HEAD"]),
});
export type PromoteInput = z.infer<typeof promoteSchema>;

// ── Department Schemas ───────────────────────────────
const departmentBase = z.object({
  name: z.string().min(1, "Department name required"),
  description: z.string().optional(),
  headId: z.number().int().positive().optional().nullable(),
  parentDeptId: z.number().int().positive().optional().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
});
export const departmentSchema = departmentBase.extend({
  status: departmentBase.shape.status.default("ACTIVE"),
});
// No defaults here, so a PUT of { name } can't silently flip status back to ACTIVE.
export const departmentUpdateSchema = departmentBase.partial();
export type DepartmentInput = z.infer<typeof departmentSchema>;

// ── Asset Category Schemas ───────────────────────────
export const categorySchema = z.object({
  name: z.string().min(1, "Category name required").max(100),
  description: z.string().optional(),
});
export const categoryUpdateSchema = categorySchema
  .extend({ customFields: z.string() })
  .partial();
export type CategoryInput = z.infer<typeof categorySchema>;

// ── Asset Schemas ────────────────────────────────────
export const assetSchema = z.object({
  name: z.string().min(1, "Asset name required"),
  categoryId: z.coerce.number().int().positive("Category required"),
  serialNumber: z.string().optional(),
  acquisitionDate: z.coerce.date().optional(),
  acquisitionCost: z.number().nonnegative().optional(),
  condition: z.enum(["GOOD", "FAIR", "POOR"]).default("GOOD"),
  location: z.string().optional(),
  isBookable: z.boolean().default(false),
  notes: z.string().optional(),
  /** Owning department. Omit or null = not assigned to any department. */
  departmentId: z.number().int().positive().nullable().optional(),
});
export type AssetInput = z.infer<typeof assetSchema>;

// ── Allocation Schemas ───────────────────────────────
const allocationBase = z.object({
  assetId: z.coerce.number().int().positive(),
  holderType: z.enum(["EMPLOYEE", "DEPARTMENT"]).default("EMPLOYEE"),
  holderId: z.coerce.number().int().positive().optional(),
  holderDeptId: z.coerce.number().int().positive().optional(),
  // "" and null mean "no return date" (null used to coerce to 1970-01-01)
  expectedReturnDate: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.coerce.date().optional()
  ),
});

export const allocationSchema = allocationBase.superRefine((d, ctx) => {
  if (d.holderType === "EMPLOYEE" && !d.holderId) {
    ctx.addIssue({ code: "custom", path: ["holderId"], message: "Employee required" });
  }
  if (d.holderType === "DEPARTMENT" && !d.holderDeptId) {
    ctx.addIssue({ code: "custom", path: ["holderDeptId"], message: "Department required" });
  }
});
export type AllocationInput = z.infer<typeof allocationSchema>;

export const allocationReturnSchema = z.object({
  condition: z.enum(["GOOD", "FAIR", "POOR"]),
  returnNotes: z.string().optional(),
});
export type AllocationReturnInput = z.infer<typeof allocationReturnSchema>;

// ── Transfer Request Schemas ─────────────────────────
export const transferRequestSchema = z.object({
  assetId: z.coerce.number().int().positive(),
  fromHolderId: z.coerce.number().int().positive().optional(),
  toHolderId: z.coerce.number().int().positive("Recipient required"),
  reason: z.string().max(500).optional(),
});
export type TransferRequestInput = z.infer<typeof transferRequestSchema>;

// ── Resource Booking Schema ──────────────────────────
export const bookingSchema = z
  .object({
    resourceId: z.coerce.number().int().positive(),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
    purpose: z.string().max(300).optional(),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: "End time must be after start time",
    path: ["endTime"],
  });
export type BookingInput = z.infer<typeof bookingSchema>;

// Moving a booking: a new time, and optionally a new purpose.
export const bookingRescheduleSchema = z
  .object({
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
    purpose: z.string().max(300).optional(),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: "End time must be after start time",
    path: ["endTime"],
  });

// ── Maintenance Request Schema ───────────────────────
export const maintenanceRequestSchema = z.object({
  assetId: z.coerce.number().int().positive(),
  description: z.string().min(5, "Description required"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  photoUrl: z.preprocess((v) => (v === "" || v === null ? undefined : v), photoUrlSchema.optional()),
});
export type MaintenanceRequestInput = z.infer<typeof maintenanceRequestSchema>;

// ── Audit Schemas ────────────────────────────────────
export const auditCycleSchema = z.object({
  name: z.string().min(1, "Audit name required"),
  scopeType: z.enum(["DEPARTMENT", "LOCATION", "ALL"]),
  scopeId: z.number().optional(),
  /** For LOCATION scope: assets whose location contains this text. */
  scopeLocation: z.string().trim().optional(),
  /** One or more people who will check assets. */
  auditorIds: z.array(z.number().int().positive()).min(1, "Assign at least one auditor"),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});
export type AuditCycleInput = z.infer<typeof auditCycleSchema>;

export const auditFindingSchema = z.object({
  assetId: z.coerce.number().int().positive(),
  status: z.enum(["VERIFIED", "MISSING", "DAMAGED"]),
  auditorNotes: z.string().optional(),
});
export type AuditFindingInput = z.infer<typeof auditFindingSchema>;

export const auditorsSchema = z.object({
  auditorIds: z.array(z.number().int().positive()).min(1, "Pick at least one auditor"),
});

export const discrepancyResolutionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  notes: z.string().trim().max(500).optional(),
});

// =====================================================
// Compatibility aliases for Asset Allocation module
// =====================================================

export const DepartmentSchema = departmentSchema;
export const CreateDepartmentSchema = departmentSchema;
export const UpdateDepartmentSchema = departmentUpdateSchema;

export const AssetCategorySchema = categorySchema.extend({
  customFields: z.string().default("{}"),
});
export const CreateAssetCategorySchema = AssetCategorySchema;
export const UpdateAssetCategorySchema = categoryUpdateSchema;

export const AssetSchema = assetSchema.extend({
  photoUrl: photoUrlSchema.optional(),
});
export const CreateAssetSchema = AssetSchema;

export const AllocationSchema = allocationSchema;
export const CreateAllocationSchema = allocationSchema;

export const ReturnAssetSchema = allocationReturnSchema;
export const TransferAssetSchema = transferRequestSchema;