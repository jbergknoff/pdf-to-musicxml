/**
 * Second half of `make upload-models`: push each weight to Netlify Blobs by
 * running `netlify blobs:set <store> <key> --input <file>` per blob in the
 * plan written by scripts/upload-models.ts.
 *
 * Runs in the `netlify-cli` Docker service (a Node image — the Netlify CLI
 * needs Node, and we invoke it with `npx` so nothing is installed on the host).
 * Requires NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID in the environment; the CLI
 * reads both. Pin the CLI with NETLIFY_CLI_VERSION (defaults to a known major).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

if (!process.env.NETLIFY_AUTH_TOKEN || !process.env.NETLIFY_SITE_ID) {
  console.error(
    "Set NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID in the environment first.",
  );
  process.exit(1);
}

const PLAN_PATH = "public/models/upload-plan.json";
const cliVersion = process.env.NETLIFY_CLI_VERSION ?? "26";

let plan;
try {
  plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
} catch {
  console.error(`Missing ${PLAN_PATH}; run scripts/upload-models.ts first.`);
  process.exit(1);
}

for (const blob of plan.blobs) {
  console.log(`Uploading ${blob.key} -> store "${plan.store}"…`);
  const result = spawnSync(
    "npx",
    [
      "-y",
      `netlify-cli@${cliVersion}`,
      "blobs:set",
      plan.store,
      blob.key,
      "--input",
      blob.file,
    ],
    { stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) {
    console.error(`Failed to upload ${blob.key}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`Uploaded ${plan.blobs.length} blob(s) to store "${plan.store}".`);
