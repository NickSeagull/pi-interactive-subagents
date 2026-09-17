#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalPath, loadAccountPolicy, resolveAccountSelection } from "../pi-extension/subagents/account-scope.mjs";
import { prepareAccountProfile } from "../pi-extension/subagents/account-profile.mjs";
import { persistAccountSessionScope, readAccountSessionMetadata, validateAccountSessionFile } from "../pi-extension/subagents/account-session.mjs";

/** Build a fully preflighted stock-Pi invocation. No process-global env changes. */
export async function prepareScopedInvocation(argv, { cwd = process.cwd(), env = process.env } = {}) {
  let config = env.PI_ACCOUNT_POLICY_FILE;
  let forceCompany = false;
  let sessionFile;
  let separator = argv.indexOf("--");
  if (separator < 0) throw new Error("Usage: pi-scoped --config FILE [--company] [--session FILE] -- PI_ARGS");
  for (let i = 0; i < separator; i++) {
    const arg = argv[i];
    if (arg === "--company") forceCompany = true;
    else if (arg === "--config" || arg === "--session") {
      const value = argv[++i];
      if (!value || i >= separator) throw new Error(`${arg} requires a path`);
      if (arg === "--config") config = value;
      else sessionFile = value;
    } else throw new Error(`Unsupported launcher option: ${arg}`);
  }
  const piArgs = argv.slice(separator + 1);
  const filtered = [];
  for (let i = 0; i < piArgs.length; i++) {
    const arg = piArgs[i];
    if (["--continue", "-c", "--resume", "-r", "--fork", "--no-session"].includes(arg)) {
      throw new Error("Scoped launches require an explicit --session FILE; interactive resume, automatic continue, CLI fork, and ephemeral sessions bypass preflight metadata selection. Use extension-managed forks instead.");
    }
    if (arg === "--api-key" || arg.startsWith("--api-key=")) throw new Error("Scoped ChatGPT accounts cannot use --api-key overrides");
    if (arg === "--session") {
      const value = piArgs[++i];
      if (!value || (sessionFile && canonicalPath(sessionFile) !== canonicalPath(value))) throw new Error("Provide one explicit session file");
      sessionFile = value;
      continue;
    }
    if (arg.startsWith("--session=")) throw new Error("Use --session FILE with a separate path argument");
    if (["--provider=", "--model=", "--models="].some((prefix) => arg.startsWith(prefix))) throw new Error("Use separate provider/model option arguments for scoped validation");
    if (arg === "--provider") {
      if (piArgs[++i] !== "openai-codex") throw new Error("Scoped ChatGPT accounts require provider openai-codex");
      continue;
    }
    if (arg === "--model" || arg === "--models") {
      const value = piArgs[++i];
      if (!value || value.split(",").some((model) => model.includes("/") && !model.startsWith("openai-codex/"))) {
        throw new Error("Scoped model selection must use openai-codex models");
      }
      filtered.push(arg, value);
      continue;
    }
    filtered.push(arg);
  }
  const markers = [env.PI_ACCOUNT_SCOPE, env.PI_ACCOUNT_PROVIDER_SCOPE];
  if (markers.some((scope) => scope !== undefined && scope !== "personal" && scope !== "company")) throw new Error("Invalid inherited account scope marker");
  const policy = loadAccountPolicy(config);
  if (sessionFile) {
    if (!isAbsolute(sessionFile) && !sessionFile.includes("/") && !sessionFile.endsWith(".jsonl")) {
      throw new Error("Session IDs cannot be preflighted; supply an explicit session file path");
    }
    sessionFile = canonicalPath(sessionFile, cwd);
    validateAccountSessionFile(sessionFile, { requireHeader: true });
  }
  const persisted = sessionFile ? readAccountSessionMetadata(sessionFile) : {};
  const currentSelection = resolveAccountSelection({ policy, cwd, parentScope: markers.includes("company") ? "company" : undefined });
  const selection = resolveAccountSelection({
    policy, cwd: persisted.cwd ?? cwd, forceCompany,
    parentScope: currentSelection.scope, persistedScope: persisted.scope,
  });
  if (persisted.policyFile && canonicalPath(persisted.policyFile) !== policy.policyFile) throw new Error("Session account policy differs from the selected policy");
  if (persisted.scope === "company" && persisted.credentialDir && canonicalPath(persisted.credentialDir) !== selection.credentialDir) {
    throw new Error("Company session credential store differs from the selected profile");
  }
  // A daemon with unexpected ambient keys must not silently use them.
  for (const key of ["OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "CODEX_API_KEY"]) {
    if (env[key]) throw new Error(`Scoped ChatGPT launch rejects ${key}; remove the API-key override from the child environment`);
  }
  await prepareAccountProfile(selection, policy);
  const sessionDir = join(selection.credentialDir, "sessions", `--${selection.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  sessionFile ??= join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`);
  if (!existsSync(sessionFile)) {
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: selection.cwd }) + "\n", { flag: "wx", mode: 0o600 });
  }
  persistAccountSessionScope(sessionFile, selection);
  const extension = fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url));
  return {
    selection, sessionFile, command: "pi",
    args: [...filtered, "--provider", "openai-codex", "--session", sessionFile, "-e", extension],
    cwd: selection.cwd,
    env: { ...env, PI_CODING_AGENT_DIR: selection.credentialDir, PI_ACCOUNT_SCOPE: selection.scope,
      PI_ACCOUNT_PROVIDER_SCOPE: selection.scope, PI_ACCOUNT_POLICY_FILE: policy.policyFile, PI_ACCOUNT_LAUNCHER: "1" },
  };
}

export async function runScopedLauncher(argv, options = {}) {
  const invocation = await prepareScopedInvocation(argv, options);
  process.stderr.write(`[pi-scoped] account=${invocation.selection.scope}; ${invocation.selection.reason}\n`);
  const child = (options.spawn ?? spawn)(invocation.command, invocation.args, {
    cwd: invocation.cwd, env: invocation.env, stdio: "inherit",
  });
  const forward = (signal) => child.kill(signal);
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    return await new Promise((resolveExit, reject) => {
      child.once("error", () => reject(new Error("Unable to start the preflighted Pi runtime")));
      child.once("exit", (code, signal) => resolveExit(code ?? (signal === "SIGINT" ? 130 : 1)));
    });
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runScopedLauncher(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`[pi-scoped] ${error.message}\n`);
    process.exitCode = 78;
  });
}
