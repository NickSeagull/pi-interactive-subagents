import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ACCOUNT_SESSION_CUSTOM_TYPE,
  ACCOUNT_SESSION_VERSION,
  createAccountSessionEntry,
  persistAccountSessionScope,
  readAccountSessionMetadata,
  readAccountSessionScope,
} from "../pi-extension/subagents/account-session.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-account-session-"));
  const sessionFile = join(directory, "session.jsonl");
  const personalDir = join(directory, "personal-profile");
  const companyDir = join(directory, "company-profile");
  const policyFile = join(directory, "policy.json");
  return { directory, sessionFile, personalDir, companyDir, policyFile };
}

function selection(fixture: ReturnType<typeof fixture>, scope: "personal" | "company") {
  return {
    scope,
    credentialDir: scope === "company" ? fixture.companyDir : fixture.personalDir,
    policyFile: fixture.policyFile,
    cwd: fixture.directory,
    reason: "test",
  };
}

test("reads the session header cwd and makes company markers monotonic", () => {
  const paths = fixture();
  const personal = createAccountSessionEntry(selection(paths, "personal"), "personal-parent");
  personal.timestamp = "2099-01-01T00:00:00.000Z";
  const firstCompany = createAccountSessionEntry(selection(paths, "company"), "company-parent");
  firstCompany.timestamp = "2090-01-01T00:00:00.000Z";
  const lastCompany = createAccountSessionEntry({
    ...selection(paths, "company"),
    cwd: join(paths.directory, "later-workspace"),
  }, "last-parent");
  lastCompany.timestamp = "2000-01-01T00:00:00.000Z";
  const trailingPersonal = createAccountSessionEntry(selection(paths, "personal"), "personal-after-company");

  writeFileSync(paths.sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "header", cwd: join(paths.directory, "session-cwd") }),
    JSON.stringify({ type: "custom", customType: "unrelated", data: { scope: "personal" } }),
    JSON.stringify(personal),
    JSON.stringify(firstCompany),
    JSON.stringify(lastCompany),
    JSON.stringify(trailingPersonal),
    "",
  ].join("\n"));

  const metadata = readAccountSessionMetadata(paths.sessionFile);
  assert.equal(metadata.scope, "company");
  assert.equal(metadata.cwd, join(paths.directory, "session-cwd"));
  assert.equal(metadata.credentialDir, paths.companyDir);
  assert.equal(metadata.policyFile, paths.policyFile);
  assert.deepEqual(readAccountSessionScope(paths.sessionFile), metadata);
});

test("recognized malformed account markers fail closed while unrelated entries remain ignorable", () => {
  const paths = fixture();
  writeFileSync(paths.sessionFile, JSON.stringify({
    type: "custom",
    customType: ACCOUNT_SESSION_CUSTOM_TYPE,
    data: { version: ACCOUNT_SESSION_VERSION + 1, scope: "company" },
  }) + "\n");
  assert.throws(() => readAccountSessionMetadata(paths.sessionFile), /Unsupported Pi account scope metadata version/);

  writeFileSync(paths.sessionFile, JSON.stringify({
    type: "custom",
    customType: ACCOUNT_SESSION_CUSTOM_TYPE,
    data: { version: ACCOUNT_SESSION_VERSION, scope: "other" },
  }) + "\n");
  assert.throws(() => readAccountSessionMetadata(paths.sessionFile), /Invalid Pi account scope metadata/);

  writeFileSync(paths.sessionFile, JSON.stringify({
    type: "custom",
    customType: "another-extension",
    data: { version: 999, scope: "other" },
  }) + "\n");
  assert.deepEqual(readAccountSessionMetadata(paths.sessionFile), {});
});

test("persists a linked custom marker idempotently and rejects company downgrade", () => {
  const paths = fixture();
  writeFileSync(paths.sessionFile, JSON.stringify({
    type: "session",
    version: 3,
    id: "leaf-id",
    cwd: paths.directory,
  }) + "\n");

  const company = selection(paths, "company");
  const first = persistAccountSessionScope(paths.sessionFile, company);
  assert.equal(first.appended, true);
  assert.equal(first.entry?.type, "custom");
  assert.equal(first.entry?.customType, ACCOUNT_SESSION_CUSTOM_TYPE);
  assert.equal(first.entry?.parentId, "leaf-id");
  assert.equal((first.entry as any)?.data.version, ACCOUNT_SESSION_VERSION);
  assert.equal((first.entry as any)?.data.scope, "company");

  const second = persistAccountSessionScope(paths.sessionFile, company);
  assert.equal(second.appended, false);
  assert.equal(readFileSync(paths.sessionFile, "utf8").split("\n").filter(Boolean).length, 2);

  assert.throws(
    () => persistAccountSessionScope(paths.sessionFile, selection(paths, "personal")),
    /Cannot downgrade/,
  );
});

test("missing session files return empty metadata without touching credential stores", () => {
  const paths = fixture();
  assert.deepEqual(readAccountSessionMetadata(join(paths.directory, "missing.jsonl")), {});
});
