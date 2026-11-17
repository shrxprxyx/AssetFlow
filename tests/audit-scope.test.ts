import { describe, it, expect } from "vitest";
import { scopeWhere, FLAGGED_STATUSES, discrepancyIsOpen } from "@/lib/auditScope";

describe("scopeWhere (which assets a cycle covers)", () => {
  it("ALL covers every asset", () => {
    expect(scopeWhere({ scopeType: "ALL", scopeLocation: null }, null)).toEqual({});
  });

  it("DEPARTMENT matches assets whose location contains the department name, ignoring case", () => {
    expect(scopeWhere({ scopeType: "DEPARTMENT", scopeLocation: null }, "Engineering")).toEqual({
      location: { contains: "Engineering", mode: "insensitive" },
    });
  });

  it("DEPARTMENT with a department that no longer exists covers nothing, not everything", () => {
    expect(scopeWhere({ scopeType: "DEPARTMENT", scopeLocation: null }, null)).toEqual({ id: -1 });
  });

  it("LOCATION matches assets whose location contains the cycle's location text", () => {
    expect(scopeWhere({ scopeType: "LOCATION", scopeLocation: "Floor 2" }, null)).toEqual({
      location: { contains: "Floor 2", mode: "insensitive" },
    });
  });

  it("LOCATION without any text covers nothing, not everything", () => {
    expect(scopeWhere({ scopeType: "LOCATION", scopeLocation: "  " }, null)).toEqual({ id: -1 });
  });
});

describe("discrepancies", () => {
  it("only MISSING and DAMAGED findings are discrepancies", () => {
    expect(FLAGGED_STATUSES).toEqual(["MISSING", "DAMAGED"]);
  });

  it("a flagged finding is open until someone approves or rejects it", () => {
    expect(discrepancyIsOpen({ status: "MISSING", resolutionStatus: "PENDING" })).toBe(true);
    expect(discrepancyIsOpen({ status: "DAMAGED", resolutionStatus: "APPROVED" })).toBe(false);
    expect(discrepancyIsOpen({ status: "MISSING", resolutionStatus: "REJECTED" })).toBe(false);
    expect(discrepancyIsOpen({ status: "VERIFIED", resolutionStatus: "PENDING" })).toBe(false);
  });
});
