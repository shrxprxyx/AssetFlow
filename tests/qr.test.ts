import { describe, it, expect } from "vitest";
import { assetLink, tagFromScan, safeNextPath } from "@/lib/qr";

describe("assetLink", () => {
  it("builds the link a label holds", () => {
    expect(assetLink("https://assets.corp.test", "AF-0001")).toBe("https://assets.corp.test/assets?tag=AF-0001");
  });
  it("ignores a trailing slash and escapes the tag", () => {
    expect(assetLink("http://localhost:3000/", "A B&C")).toBe("http://localhost:3000/assets?tag=A%20B%26C");
  });
});

describe("tagFromScan", () => {
  it("reads the tag from our link, whatever the host", () => {
    expect(tagFromScan("https://assets.corp.test/assets?tag=AF-0042")).toBe("AF-0042");
    expect(tagFromScan("http://localhost:3000/assets/?tag=AF-0042")).toBe("AF-0042");
  });
  it("round-trips with assetLink", () => {
    expect(tagFromScan(assetLink("https://x.test", "AF-0007"))).toBe("AF-0007");
  });
  it("accepts a bare tag, trimmed", () => {
    expect(tagFromScan("  AF-0001\n")).toBe("AF-0001");
  });
  it("rejects codes that are not asset tags", () => {
    expect(tagFromScan("")).toBeNull();
    expect(tagFromScan("https://example.com/")).toBeNull();
    expect(tagFromScan("https://example.com/other?tag=AF-1")).toBeNull();
    expect(tagFromScan("WIFI:S:office;T:WPA;P:secret;;")).toBeNull();
    expect(tagFromScan("two words")).toBeNull();
  });
});

describe("safeNextPath", () => {
  it("allows paths inside the app, with their query", () => {
    expect(safeNextPath("/assets?tag=AF-0001")).toBe("/assets?tag=AF-0001");
    expect(safeNextPath("/bookings")).toBe("/bookings");
  });
  it("falls back for anything that could leave the site", () => {
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "evil.com", "javascript:alert(1)", "", null, undefined]) {
      expect(safeNextPath(bad as string | null | undefined), String(bad)).toBe("/dashboard");
    }
  });
  it("does not bounce back to a sign-in page", () => {
    expect(safeNextPath("/login")).toBe("/dashboard");
    expect(safeNextPath("/login?callbackUrl=%2Fassets")).toBe("/dashboard");
    expect(safeNextPath("/reset-password")).toBe("/dashboard");
  });
});
