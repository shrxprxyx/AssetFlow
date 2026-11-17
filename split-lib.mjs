// Splits src/lib into src/services (talks to the database, Redis, mail, files, the network)
// and src/utils (pure helpers), and rewrites every import that points at the old files.
// Run once from the project root:  node split-lib.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join, extname, basename } from "node:path";

const UTILS = new Set(["utils", "qr", "heatmap", "pagination", "schemas", "http", "imageUpload", "auditScope"]);
const SKIP_NAMES = new Set(["node_modules", ".next", ".git"]);
// Full paths, so a folder that merely has the same name deeper down (src/app/api/uploads) is still processed.
const SKIP_PATHS = new Set(["prisma/migrations", "uploads", "load-test/results"]);
const norm = (p) => p.replaceAll("\\", "/");
const TEXT = new Set([".ts", ".tsx", ".mjs", ".js", ".md", ".json"]);

if (!existsSync("package.json") || !existsSync("src/lib")) throw new Error("Run this from the project root, with src/lib present.");
if (existsSync("src/services") || existsSync("src/utils")) throw new Error("src/services or src/utils already exists. Nothing was changed.");

const files = readdirSync("src/lib");
const unexpected = files.filter((f) => !f.endsWith(".ts"));
if (unexpected.length) throw new Error(`src/lib has files this script doesn't know how to place: ${unexpected.join(", ")}`);
for (const u of UTILS) if (!files.includes(`${u}.ts`)) throw new Error(`Expected src/lib/${u}.ts but it is missing.`);

const dest = {}; // name -> "services" | "utils"
for (const f of files) {
  const name = basename(f, ".ts");
  dest[name] = UTILS.has(name) ? "utils" : "services";
}

mkdirSync("src/services");
mkdirSync("src/utils");
for (const [name, dir] of Object.entries(dest)) renameSync(`src/lib/${name}.ts`, `src/${dir}/${name}.ts`);
rmdirSync("src/lib");

const names = Object.keys(dest).sort((a, b) => b.length - a.length).join("|");
const rules = [
  // "@/lib/x", also inside vi.mock("...") and import("...")
  [new RegExp(`@/lib/(${names})\\b`, "g"), (_m, n) => `@/${dest[n]}/${n}`],
  // "../src/lib/x" (worker, tests)
  [new RegExp(`(\\.\\./)+src/lib/(${names})\\b`, "g"), (m, _g, n) => m.replace(`src/lib/${n}`, `src/${dest[n]}/${n}`)],
  // "src/lib/x" and "lib/x" written in comments and docs
  [new RegExp(`(?<![\\w@/.-])(src/)?lib/(${names})\\b`, "g"), (_m, pre, n) => `${pre ?? ""}${dest[n] === "utils" ? "utils" : "services"}/${n}`],
];

let changed = 0;
const targets = ["src", "tests", "worker", "prisma", "load-test", "docs", "readme.md", "components.json"];
function walk(p) {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) {
    for (const e of readdirSync(p)) {
      const child = join(p, e);
      if (!SKIP_NAMES.has(e) && !SKIP_PATHS.has(norm(child))) walk(child);
    }
    return;
  }
  if (!TEXT.has(extname(p))) return;
  const before = readFileSync(p, "utf8");
  let after = before;
  for (const [re, fn] of rules) after = after.replace(re, fn);
  // Siblings that imported each other as "./x" may now sit in the other folder.
  const np = norm(p);
  if (np.startsWith("src/services/") || np.startsWith("src/utils/")) {
    const here = np.startsWith("src/services/") ? "services" : "utils";
    after = after.replace(new RegExp(`from "\\./(${names})"`, "g"), (m, n) => (dest[n] === here ? m : `from "@/${dest[n]}/${n}"`));
  }
  if (after !== before) {
    writeFileSync(p, after);
    changed++;
  }
}
for (const t of targets) walk(t);

// shadcn reads these aliases when you run `npx shadcn add ...`
if (existsSync("components.json")) {
  const c = JSON.parse(readFileSync("components.json", "utf8"));
  if (c.aliases) {
    c.aliases.utils = "@/utils/utils";
    c.aliases.lib = "@/utils";
    writeFileSync("components.json", JSON.stringify(c, null, 2) + "\n");
  }
}

if (existsSync(".next")) {
  // A stale build cache would still point at the old paths.
  import("node:fs").then(({ rmSync }) => rmSync(".next", { recursive: true, force: true }));
}
console.log(`Moved ${files.length} files (${Object.values(dest).filter((d) => d === "services").length} to src/services, ${Object.values(dest).filter((d) => d === "utils").length} to src/utils) and rewrote ${changed} other files.`);
