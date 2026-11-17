import { describe, it, expect } from "vitest";
import { CreateAssetSchema } from "@/utils/schemas";

const base = { name: "Laptop", categoryId: 1 };

describe("asset schema: departmentId", () => {
  it("is optional", () => {
    expect(CreateAssetSchema.safeParse(base).success).toBe(true);
  });
  it("accepts a positive integer or null", () => {
    expect(CreateAssetSchema.safeParse({ ...base, departmentId: 3 }).success).toBe(true);
    expect(CreateAssetSchema.safeParse({ ...base, departmentId: null }).success).toBe(true);
  });
  it("rejects zero, negatives, fractions and strings", () => {
    for (const bad of [0, -1, 1.5, "3"]) {
      expect(CreateAssetSchema.safeParse({ ...base, departmentId: bad }).success, String(bad)).toBe(false);
    }
  });
});
