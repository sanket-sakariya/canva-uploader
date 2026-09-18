/** Runs every suite in its own process — each one snapshots a different env. */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const suites = ["jpeg.test.ts", "e2e.test.ts", "proxy.test.ts"];

let failed = 0;
for (const suite of suites) {
  console.log(`\n${"─".repeat(58)}\n▶ ${suite}\n${"─".repeat(58)}`);
  const res = spawnSync(process.execPath, [resolve(HERE, "../node_modules/tsx/dist/cli.mjs"), resolve(HERE, suite)], {
    stdio: "inherit",
    cwd: resolve(HERE, ".."),
  });
  if (res.status !== 0) failed++;
}

console.log(`\n${"═".repeat(58)}`);
console.log(failed ? `${failed} suite(s) FAILED` : "all suites passed");
process.exit(failed ? 1 : 0);
