import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  persistAccountSessionScope,
  readAccountSessionMetadata,
} from "../pi-extension/subagents/account-session.mjs";
import {
  formatCompanyResumeInstruction,
  registerAccountScopeGuard,
} from "../pi-extension/subagents/account-scope-guard.ts";

type Handler = (event: any, context: any) => unknown;

function makeFixture({ companyCredentials = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-account-guard-"));
  const personalAgentDir = join(directory, "personal-agent");
  const companyAgentDir = join(directory, "company-agent");
  const companyRoot = join(directory, "company-work");
  const openRoot = join(directory, "open-source");
  mkdirSync(personalAgentDir, { recursive: true });
  if (companyCredentials) mkdirSync(companyAgentDir, { recursive: true });
  mkdirSync(companyRoot, { recursive: true });
  mkdirSync(openRoot, { recursive: true });
  const policyFile = join(directory, "accounts.json");
  writeFileSync(policyFile, JSON.stringify({
    personalAgentDir,
    companyAgentDir,
    companyRoots: [companyRoot],
  }) + "\n");
  return { directory, personalAgentDir, companyAgentDir, companyRoot, openRoot, policyFile };
}

function scopedEnv(paths: ReturnType<typeof makeFixture>, scope: "personal" | "company") {
  return {
    PI_ACCOUNT_LAUNCHER: "1",
    PI_ACCOUNT_SCOPE: scope,
    PI_ACCOUNT_PROVIDER_SCOPE: scope,
    PI_ACCOUNT_POLICY_FILE: paths.policyFile,
    PI_CODING_AGENT_DIR: scope === "company" ? paths.companyAgentDir : paths.personalAgentDir,
  };
}

function makePi(sessionFile?: string) {
  const handlers = new Map<string, Handler[]>();
  const appendCalls: Array<{ customType: string; data: any }> = [];
  const pi = {
    handlers,
    appendCalls,
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry(customType: string, data: any) {
      appendCalls.push({ customType, data });
      if (sessionFile) {
        const raw = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8") : "";
        const lines = raw.split(/\r?\n/).filter((line) => line.trim());
        const previous = lines.length ? JSON.parse(lines[lines.length - 1]) : undefined;
        appendFileSync(sessionFile, JSON.stringify({
          type: "custom",
          customType,
          data,
          id: randomUUID(),
          ...(previous?.id ? { parentId: previous.id } : {}),
          timestamp: new Date().toISOString(),
        }) + "\n");
      }
    },
  } as any;
  return pi;
}

function makeContext(sessionFile: string, cwd: string) {
  const statuses: Array<[string, string | undefined]> = [];
  const notifications: string[] = [];
  const context = {
    cwd,
    statuses,
    notifications,
    ui: {
      setStatus(key: string, text: string | undefined) {
        statuses.push([key, text]);
      },
      notify(message: string) {
        notifications.push(message);
      },
    },
    sessionManager: {
      getSessionFile: () => sessionFile,
    },
  } as any;
  return context;
}

function writeSession(sessionFile: string, cwd: string, id = "header") {
  writeFileSync(sessionFile, JSON.stringify({
    type: "session",
    version: 3,
    id,
    cwd,
  }) + "\n");
}

function handler(pi: any, event: string): Handler {
  const registered = pi.handlers.get(event)?.[0];
  assert.ok(registered, `expected ${event} handler`);
  return registered;
}

test("is inactive without the dedicated launcher marker", () => {
  const pi = makePi();
  assert.equal(registerAccountScopeGuard(pi, { env: {} }), null);
  assert.equal(pi.handlers.size, 0);
});

test("initializes a personal runtime from the session cwd and persists its scope", () => {
  const paths = makeFixture();
  const sessionFile = join(paths.directory, "personal.jsonl");
  writeSession(sessionFile, paths.openRoot);
  const pi = makePi(sessionFile);
  const ctx = makeContext(sessionFile, paths.openRoot);
  const guard = registerAccountScopeGuard(pi, { env: scopedEnv(paths, "personal") });
  assert.ok(guard);

  handler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(guard.getStatus().scope, "personal");
  assert.equal(guard.getStatus().initialized, true);
  assert.equal(readAccountSessionMetadata(sessionFile).scope, "personal");
  assert.equal(pi.appendCalls.length, 1);
  assert.equal(pi.appendCalls[0].data.scope, "personal");
});

test("company scope remains sticky outside company roots and upgrades a personal marker safely", () => {
  const paths = makeFixture();
  const sessionFile = join(paths.directory, "company.jsonl");
  writeSession(sessionFile, paths.openRoot);
  const pi = makePi(sessionFile);
  const ctx = makeContext(sessionFile, paths.openRoot);
  const guard = registerAccountScopeGuard(pi, { env: scopedEnv(paths, "company") });
  assert.ok(guard);

  // A launcher-selected company parent carries company scope even when this
  // session's cwd is an open-source checkout.
  handler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(guard.getStatus().scope, "company");
  assert.equal(readAccountSessionMetadata(sessionFile).scope, "company");

  // A lineage seed may still contain a personal marker. The company launcher
  // can upgrade that marker to the selected company profile safely.
  const upgradedFile = join(paths.directory, "upgraded.jsonl");
  writeSession(upgradedFile, paths.companyRoot);
  const personalEntry = {
    type: "custom",
    customType: "pi-account-scope",
    id: "personal-marker",
    parentId: "header",
    timestamp: new Date().toISOString(),
    data: {
      version: 1,
      scope: "personal",
      credentialDir: paths.personalAgentDir,
      policyFile: paths.policyFile,
      cwd: paths.companyRoot,
    },
  };
  appendFileSync(upgradedFile, JSON.stringify(personalEntry) + "\n");
  const upgradePi = makePi(upgradedFile);
  const upgradeCtx = makeContext(upgradedFile, paths.companyRoot);
  const upgradeGuard = registerAccountScopeGuard(upgradePi, { env: scopedEnv(paths, "company") });
  assert.ok(upgradeGuard);
  handler(upgradePi, "session_start")({ type: "session_start", reason: "fork" }, upgradeCtx);
  assert.equal(readAccountSessionMetadata(upgradedFile).scope, "company");
  assert.equal(upgradePi.appendCalls[0].data.scope, "company");
});

test("a company profile that is unavailable exits 78 before a provider request", () => {
  const paths = makeFixture({ companyCredentials: false });
  const sessionFile = join(paths.directory, "missing-company.jsonl");
  writeSession(sessionFile, paths.openRoot);
  const pi = makePi(sessionFile);
  const ctx = makeContext(sessionFile, paths.openRoot);
  const exits: number[] = [];
  const diagnostics: string[] = [];
  registerAccountScopeGuard(pi, {
    env: scopedEnv(paths, "company"),
    exit: (code) => exits.push(code),
    stderr: { write: (message) => diagnostics.push(message) },
  });

  let requests = 0;
  assert.throws(() => {
    handler(pi, "before_provider_request")({ type: "before_provider_request", payload: {} }, ctx);
    requests += 1;
  }, /Company credentials\/configuration are unavailable/);
  assert.deepEqual(exits, [78]);
  assert.equal(requests, 0);
  assert.match(diagnostics.join(""), /company/i);
});

test("a personal runtime refuses a company target and explains the scoped relaunch", () => {
  const paths = makeFixture();
  const currentFile = join(paths.directory, "current.jsonl");
  const targetFile = join(paths.directory, "target.jsonl");
  writeSession(currentFile, paths.openRoot);
  writeSession(targetFile, paths.openRoot, "target-header");
  persistAccountSessionScope(targetFile, {
    scope: "company",
    credentialDir: paths.companyAgentDir,
    policyFile: paths.policyFile,
    cwd: paths.openRoot,
  });
  const pi = makePi(currentFile);
  const ctx = makeContext(currentFile, paths.openRoot);
  const guard = registerAccountScopeGuard(pi, { env: scopedEnv(paths, "personal") });
  assert.ok(guard);
  handler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
  const result = handler(pi, "session_before_switch")({
    type: "session_before_switch",
    reason: "resume",
    targetSessionFile: targetFile,
  }, ctx);
  assert.deepEqual(result, { cancel: true });
  assert.match(ctx.notifications.join("\n"), /--config/);
  assert.match(ctx.notifications.join("\n"), /--company/);
  assert.match(ctx.notifications.join("\n"), /--session/);
});

test("company runtime may switch to an open-source session while retaining company scope", () => {
  const paths = makeFixture();
  const currentFile = join(paths.directory, "company-current.jsonl");
  const targetFile = join(paths.directory, "open-target.jsonl");
  writeSession(currentFile, paths.companyRoot);
  writeSession(targetFile, paths.openRoot, "open-header");
  const pi = makePi(currentFile);
  const ctx = makeContext(currentFile, paths.companyRoot);
  const guard = registerAccountScopeGuard(pi, { env: scopedEnv(paths, "company") });
  assert.ok(guard);
  handler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
  const result = handler(pi, "session_before_switch")({
    type: "session_before_switch",
    reason: "resume",
    targetSessionFile: targetFile,
  }, ctx);
  assert.equal(result, undefined);
});

test("subprocess guard prevents a fake provider request for a foreign model provider", () => {
  const paths = makeFixture();
  const sessionFile = join(paths.directory, "subprocess.jsonl");
  writeSession(sessionFile, paths.openRoot);
  const guardFile = join(dirname(new URL(import.meta.url).pathname), "../pi-extension/subagents/account-scope-guard.ts");
  const script = `
    import { registerAccountScopeGuard } from ${JSON.stringify(pathToFileURL(guardFile).href)};
    const handlers = new Map();
    const pi = { on(name, handler) { handlers.set(name, handler); }, appendEntry() {} };
    const ctx = {
      cwd: ${JSON.stringify(paths.openRoot)},
      model: { provider: "anthropic" },
      sessionManager: { getSessionFile: () => ${JSON.stringify(sessionFile)} },
      ui: { setStatus() {}, notify() {} },
    };
    let requests = 0;
    let exitCode = null;
    registerAccountScopeGuard(pi, {
      exit(code) { exitCode = code; },
      stderr: { write() {} },
    });
    try { handlers.get("before_provider_request")({ type: "before_provider_request", payload: {} }, ctx); }
    catch {}
    if (exitCode === null) requests += 1;
    process.stdout.write(JSON.stringify({ requests, exitCode }));
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: paths.directory,
    env: {
      ...process.env,
      ...scopedEnv(paths, "company"),
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { requests: 0, exitCode: 78 });
});

test("resume diagnostics use the launcher configuration contract", () => {
  assert.equal(
    formatCompanyResumeInstruction("/tmp/child.jsonl", "pi-scoped", "/tmp/accounts.json"),
    'pi-scoped --config "/tmp/accounts.json" --company --session "/tmp/child.jsonl" --',
  );
});
