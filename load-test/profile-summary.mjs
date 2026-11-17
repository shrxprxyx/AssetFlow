// Totals a V8 CPU profile (the .cpuprofile files that `node --cpu-prof` writes) so you can see
// WHERE the server spends its CPU without opening Chrome DevTools.
//
//   node load-test/profile-summary.mjs prof                 # every .cpuprofile in the folder "prof"
//   node load-test/profile-summary.mjs prof/CPU.123.cpuprofile --top 40
//
// Prints, for the busiest process in the profile(s):
//   1. how the time splits: your code, Next.js, other packages, Node itself, garbage collection, idle
//   2. the functions with the most SELF time (time in the function itself, not in what it calls)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const topIdx = args.indexOf("--top");
const TOP = topIdx >= 0 ? Number(args[topIdx + 1]) : 25;
const inputs = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--top");
if (inputs.length === 0) {
  console.error("Usage: node load-test/profile-summary.mjs <folder or .cpuprofile files> [--top 25]");
  process.exit(1);
}

const files = inputs.flatMap((p) =>
  statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith(".cpuprofile")).map((f) => join(p, f)) : [p]
);
if (files.length === 0) {
  console.error("No .cpuprofile files found.");
  process.exit(1);
}

const norm = (u) => (u || "").replaceAll("\\", "/");

/** Which part of the system a function belongs to. */
function areaOf(fn, url) {
  const u = norm(url);
  if (fn === "(garbage collector)") return "garbage collection";
  if (fn === "(idle)") return "idle";
  if (fn === "(program)" || fn === "(root)" || fn === "") return "native / program";
  if (u.startsWith("node:") || u === "") return "Node itself";
  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(u);
  if (pkg) return pkg[1] === "next" || pkg[1].startsWith("next-") ? `Next.js (${pkg[1]})` : `package: ${pkg[1]}`;
  if (/\.next\/server\//.test(u)) return "built app + bundled packages (.next/server)";
  if (/\/src\//.test(u)) return "your code (src)";
  return "other";
}

const self = new Map(); // key -> microseconds
const areas = new Map();
const summaries = [];

for (const file of files) {
  const prof = JSON.parse(readFileSync(file, "utf8"));
  const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
  const perNode = new Map();
  prof.samples.forEach((id, i) => perNode.set(id, (perNode.get(id) ?? 0) + (prof.timeDeltas[i] ?? 0)));

  let busy = 0;
  let total = 0;
  for (const [id, us] of perNode) {
    const { callFrame: c } = nodes.get(id);
    const area = areaOf(c.functionName, c.url);
    total += us;
    if (area !== "idle") busy += us;
    areas.set(area, (areas.get(area) ?? 0) + us);
    if (area === "idle") continue;
    const where = c.url ? `${norm(c.url).split("/").slice(-3).join("/")}:${c.lineNumber + 1}` : "(native)";
    const key = `${c.functionName || "(anonymous)"}  ${where}`;
    self.set(key, (self.get(key) ?? 0) + us);
  }
  summaries.push({ file, seconds: total / 1e6, busy: busy / 1e6 });
}

const ms = (us) => (us / 1000).toFixed(0).padStart(8) + " ms";
const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
const busyTotal = sum(areas) - (areas.get("idle") ?? 0);

console.log(`\nProfiles: ${files.length}`);
for (const s of summaries) console.log(`  ${s.file}: ${s.seconds.toFixed(1)} s sampled, ${s.busy.toFixed(1)} s busy`);

console.log("\nWhere the busy time went");
for (const [area, us] of [...areas].filter(([a]) => a !== "idle").sort((a, b) => b[1] - a[1])) {
  console.log(`${ms(us)}  ${((us / busyTotal) * 100).toFixed(1).padStart(5)} %  ${area}`);
}
if (areas.has("idle")) console.log(`${ms(areas.get("idle"))}         idle (waiting for work)`);

console.log(`\nTop ${TOP} functions by self time`);
for (const [key, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
  console.log(`${ms(us)}  ${((us / busyTotal) * 100).toFixed(1).padStart(5)} %  ${key}`);
}
console.log("");
