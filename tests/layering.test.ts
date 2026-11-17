import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The folder layout is only worth having if it stays true.

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === ".next" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const importsOf = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);

describe("folder layering", () => {
  it("src/utils never imports from src/services", () => {
    const offenders = sourceFiles("src/utils").filter((f) => importsOf(f).some((i) => /(^|\/)services(\/|$)/.test(i)));

    expect(offenders).toEqual([]);
  });

  it("nothing still imports from the old src/lib", () => {
    const roots = ["src", "tests", "worker", "prisma"].flatMap((d) => sourceFiles(d));
    const offenders = roots.filter((f) => importsOf(f).some((i) => /(^@\/lib\/)|(\/src\/lib\/)/.test(i)));

    expect(offenders).toEqual([]);
  });

  it("every import of @/services or @/utils points at a file that exists", () => {
    const missing: string[] = [];
    for (const f of ["src", "tests", "worker"].flatMap((d) => sourceFiles(d))) {
      for (const i of importsOf(f)) {
        const m = /^@\/(services|utils)\/(.+)$/.exec(i);
        if (m && !sourceFiles(`src/${m[1]}`).some((p) => p.replaceAll("\\", "/").endsWith(`/${m[2]}.ts`))) missing.push(`${f} -> ${i}`);
      }
    }

    expect(missing).toEqual([]);
  });
});
