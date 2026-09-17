import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSubagentSessionFile } from "../pi-extension/subagents/session.ts";
import { createAccountSessionEntry, readAccountSessionMetadata } from "../pi-extension/subagents/account-session.mjs";

for (const mode of ["lineage-only", "fork"] as const) {
  test(`${mode} preserves company scope even when its marker follows the fork cutoff`, () => {
    const dir = mkdtempSync(join(tmpdir(), "account-lineage-"));
    try {
      const parent = join(dir, "parent.jsonl");
      const child = join(dir, "child.jsonl");
      const selection = { scope: "company" as const, cwd: join(dir, "company-project"),
        credentialDir: join(dir, "company-profile"), policyFile: join(dir, "policy.json") };
      writeFileSync(parent, [
        { type: "session", version: 3, id: "session", cwd: selection.cwd },
        { type: "message", id: "cutoff", message: { role: "user", content: "fork here" } },
        createAccountSessionEntry(selection, "cutoff"),
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const childCwd = join(dir, "open-source");
      seedSubagentSessionFile({ mode, parentSessionFile: parent, childSessionFile: child, childCwd });
      assert.deepEqual(readAccountSessionMetadata(child), { ...selection, cwd: childCwd, version: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
