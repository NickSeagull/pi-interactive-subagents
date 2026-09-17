import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { prepareScopedInvocation, runScopedLauncher } from "../bin/pi-scoped.mjs";
import { prepareScopedLaunch } from "../pi-extension/subagents/account-launch.mjs";
import { canonicalPath, loadAccountPolicy, resolveAccountSelection } from "../pi-extension/subagents/account-scope.mjs";
import { prepareAccountProfile } from "../pi-extension/subagents/account-profile.mjs";
import { readAccountSessionMetadata } from "../pi-extension/subagents/account-session.mjs";

function fixture() {
  const dir = canonicalPath(mkdtempSync(join(tmpdir(), "pi-scoped-fixture-")));
  const policyFile = join(dir, "policy.json");
  const personal = join(dir, "personal");
  const company = join(dir, "company");
  const work = join(dir, "work");
  const oss = join(dir, "oss");
  for (const path of [personal, company, work, oss]) mkdirSync(path);
  // These are deliberately nonfunctional fixture tokens, never real auth.
  for (const [profile, name] of [[personal, "fixture-personal"], [company, "fixture-company"]]) {
    writeFileSync(join(profile, "auth.json"), JSON.stringify({ "openai-codex": {
      type: "oauth", access: `${name}-access`, refresh: `${name}-refresh`, expires: 1,
    } }));
  }
  writeFileSync(policyFile, JSON.stringify({ personalAgentDir: personal, companyAgentDir: company, companyRoots: [work] }));
  return { dir, policyFile, personal, company, work, oss, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("launcher selects personal/company, sticky descendants, and resume with explicit independent stores", async () => {
  const f = fixture();
  try {
    const args = ["--config", f.policyFile, "--"];
    const personal = await prepareScopedInvocation(args, { cwd: f.oss, env: {} });
    assert.equal(personal.selection.scope, "personal");
    const company = await prepareScopedInvocation(args, { cwd: f.work, env: personal.env });
    assert.equal(company.selection.scope, "company");
    const descendant = await prepareScopedInvocation(args, { cwd: f.oss, env: company.env });
    assert.equal(descendant.selection.scope, "company");
    assert.equal(descendant.env.PI_CODING_AGENT_DIR, f.company);
    const resumed = await prepareScopedInvocation(["--config", f.policyFile, "--session", descendant.sessionFile, "--"], { cwd: f.oss, env: {} });
    assert.equal(resumed.selection.scope, "company");
    assert.equal(readAccountSessionMetadata(resumed.sessionFile).scope, "company");
    const forced = await prepareScopedInvocation(["--config", f.policyFile, "--company", "--"], { cwd: f.oss, env: {} });
    assert.equal(forced.selection.scope, "company");
    assert.equal(personal.command, "pi");
  } finally { f.cleanup(); }
});

test("concurrent scopes use explicit child environments despite conflicting ambient profile", async () => {
  const f = fixture();
  const before = process.env.PI_CODING_AGENT_DIR;
  try {
    const ambient = { PI_CODING_AGENT_DIR: "/unrelated-daemon-profile" };
    const args = ["--config", f.policyFile, "--"];
    const [personal, company] = await Promise.all([
      prepareScopedInvocation(args, { cwd: f.oss, env: ambient }),
      prepareScopedInvocation(args, { cwd: f.work, env: ambient }),
    ]);
    assert.equal(personal.env.PI_CODING_AGENT_DIR, f.personal);
    assert.equal(company.env.PI_CODING_AGENT_DIR, f.company);
    assert.equal(ambient.PI_CODING_AGENT_DIR, "/unrelated-daemon-profile");
    assert.equal(process.env.PI_CODING_AGENT_DIR, before);
    assert.notEqual(personal.sessionFile, company.sessionFile);
  } finally { f.cleanup(); }
});

test("missing or non-OAuth company auth fails before starting a child, with no personal fallback", async () => {
  const f = fixture();
  let launches = 0;
  const options = { cwd: f.work, env: {}, spawn: () => { launches++; throw new Error("must not launch"); } };
  try {
    rmSync(join(f.company, "auth.json"));
    await assert.rejects(runScopedLauncher(["--config", f.policyFile, "--"], options), /company account profile is unavailable/);
    writeFileSync(join(f.company, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: "fixture-key" } }));
    await assert.rejects(runScopedLauncher(["--config", f.policyFile, "--"], options), /requires independent openai-codex OAuth/);
    assert.equal(launches, 0);
    assert.equal(existsSync(join(f.company, "sessions")), false);
  } finally { f.cleanup(); }
});

test("launcher rejects bypass flags, foreign models and environment API keys before launch", async () => {
  const f = fixture();
  try {
    for (const args of [["--continue"], ["--resume"], ["--fork", "id"], ["--no-session"], ["--api-key", "fixture"], ["--provider", "openai"], ["--model", "openai/gpt-4o"]]) {
      await assert.rejects(prepareScopedInvocation(["--config", f.policyFile, "--", ...args], { cwd: f.oss, env: {} }));
    }
    await assert.rejects(prepareScopedInvocation(["--config", f.policyFile, "--"], { cwd: f.work, env: { OPENAI_API_KEY: "fixture" } }), /rejects OPENAI_API_KEY/);
  } finally { f.cleanup(); }
});

test("profile preparation rejects auth symlinks and shares only allowlisted absent noncredential resources", async () => {
  const f = fixture();
  try {
    const shared = join(f.dir, "shared");
    mkdirSync(shared);
    mkdirSync(join(shared, "skills"));
    writeFileSync(join(shared, "auth.json"), "fixture-do-not-share");
    writeFileSync(join(shared, "settings.json"), "fixture-shared-settings");
    writeFileSync(join(f.company, "settings.json"), "fixture-existing-settings");
    const policy = { ...loadAccountPolicy(f.policyFile), sharedConfigDir: shared };
    const selection = resolveAccountSelection({ policy, cwd: f.work });
    const before = readFileSync(join(f.company, "auth.json"), "utf8");
    await prepareAccountProfile(selection, policy);
    assert.equal(readFileSync(join(f.company, "auth.json"), "utf8"), before);
    assert.equal(readFileSync(join(f.company, "settings.json"), "utf8"), "fixture-existing-settings");
    assert.equal(canonicalPath(join(f.company, "skills")), join(shared, "skills"));
    await prepareAccountProfile(resolveAccountSelection({ policy, cwd: f.oss }), policy);
    assert.equal(readFileSync(join(f.personal, "settings.json"), "utf8"), "fixture-shared-settings");
    rmSync(join(f.company, "auth.json"));
    symlinkSync(join(f.personal, "auth.json"), join(f.company, "auth.json"));
    await assert.rejects(prepareAccountProfile(selection, policy), /private regular file/);
  } finally { f.cleanup(); }
});

test("terminal child preflight carries sticky parent metadata and canonical profile", async () => {
  const f = fixture();
  try {
    const parent = await prepareScopedInvocation(["--config", f.policyFile, "--"], { cwd: f.work, env: {} });
    const child = await prepareScopedLaunch({ cwd: f.oss, parentSessionFile: parent.sessionFile, env: {} });
    assert.equal(child.scope, "company");
    assert.equal(child.env.PI_CODING_AGENT_DIR, f.company);
    assert.ok(existsSync(child.command[1]));
  } finally { f.cleanup(); }
});

test("CLI entrypoint preflights before invoking stock pi from PATH with explicit scope", async () => {
  const f = fixture();
  try {
    const bin = join(f.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pi"), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({scope:process.env.PI_ACCOUNT_SCOPE,dir:process.env.PI_CODING_AGENT_DIR,args:process.argv.slice(2)}));\n`, { mode: 0o700 });
    const launcher = fileURLToPath(new URL("../bin/pi-scoped.mjs", import.meta.url));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [launcher, "--config", f.policyFile, "--company", "--", "--mode", "rpc"], {
      cwd: f.oss, env: { PATH: bin, PI_CODING_AGENT_DIR: "/unrelated-daemon-profile" },
    });
    const child = JSON.parse(stdout);
    assert.equal(child.scope, "company");
    assert.equal(child.dir, f.company);
    assert.ok(child.args.includes("rpc"));
    assert.ok(child.args.includes("--session"));
    assert.match(stderr, /account=company/);
  } finally { f.cleanup(); }
});

test("session paths cannot read or corrupt credential stores, hard links, or malformed files", async () => {
  const f = fixture();
  try {
    const auth = join(f.company, "auth.json");
    const before = readFileSync(auth, "utf8"); // synthetic fixture only
    const alias = join(f.dir, "alias.jsonl");
    symlinkSync(auth, alias);
    const hard = join(f.dir, "hard.jsonl");
    linkSync(auth, hard);
    const empty = join(f.dir, "empty.jsonl");
    writeFileSync(empty, "");
    const malformed = join(f.dir, "malformed.jsonl");
    writeFileSync(malformed, "{}\n");
    for (const session of [auth, alias, hard, empty, malformed]) {
      await assert.rejects(prepareScopedInvocation(["--config", f.policyFile, "--session", session, "--"], { cwd: f.oss, env: {} }));
      await assert.rejects(prepareScopedLaunch({ cwd: f.oss, sessionFile: session, env: { PI_ACCOUNT_POLICY_FILE: f.policyFile } }));
    }
    assert.equal(readFileSync(auth, "utf8"), before);
    assert.equal(readFileSync(empty, "utf8"), "");
    assert.equal(readFileSync(malformed, "utf8"), "{}\n");
    for (const flag of ["--provider=openai", "--model=openai/gpt-4o", "--models=*"]) {
      await assert.rejects(prepareScopedInvocation(["--config", f.policyFile, "--", flag], { cwd: f.oss, env: {} }), /separate provider\/model/);
    }
  } finally { f.cleanup(); }
});
