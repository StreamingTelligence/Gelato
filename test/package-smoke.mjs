import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packages = [
  {
    workspace: "@gelato/server-core",
    required: ["package.json", "README.md", "dist/index.js", "dist/index.d.ts"]
  },
  {
    workspace: "@gelato/model-interface",
    required: [
      "package.json",
      "README.md",
      "protocol.md",
      "dist/index.js",
      "dist/index.d.ts",
      "schemas/model-event.schema.json"
    ]
  }
];

const cache = mkdtempSync(join(tmpdir(), "gelato-npm-cache-"));
try {
  for (const item of packages) {
    const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--workspace", item.workspace], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, npm_config_cache: cache }
    });
    const report = JSON.parse(raw);
    const files = new Set(report[0]?.files?.map(value => value.path));
    for (const required of item.required) {
      if (!files.has(required)) throw new Error(`${item.workspace} package is missing ${required}`);
    }
  }
} finally {
  rmSync(cache, { recursive: true, force: true });
}

await access(new URL("../server-sdk/core/dist/index.js", import.meta.url));
await access(new URL("../model_interface/dist/index.js", import.meta.url));
await import(new URL("../server-sdk/core/dist/index.js", import.meta.url));
await import(new URL("../model_interface/dist/index.js", import.meta.url));

console.log("Package contents and public ESM entry points are valid.");
