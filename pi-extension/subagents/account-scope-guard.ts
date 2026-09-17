/**
 * Runtime diagnostics and trusted-launcher guard for sticky account scope.
 *
 * The launcher chooses PI_CODING_AGENT_DIR before Pi (and before any model
 * runtime) is created. This extension guard verifies that frozen choice and
 * records it in the Pi session. It cannot intercept arbitrary in-process SDK
 * calls made by unrelated extensions; before_provider_request is a diagnostic
 * backstop because Pi may resolve provider auth before invoking that hook.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeSwitchEvent,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { statSync } from "node:fs";

import {
  canonicalPath,
  loadAccountPolicy,
  resolveAccountSelection,
} from "./account-scope.mjs";
import {
  ACCOUNT_SESSION_CUSTOM_TYPE,
  ACCOUNT_SESSION_VERSION,
  readAccountSessionMetadata,
} from "./account-session.mjs";

export type AccountScope = "personal" | "company";

export interface AccountSelection {
  scope: AccountScope;
  credentialDir: string;
  policyFile: string;
  reason: string;
  cwd: string;
}

export interface AccountScopeGuardStatus {
  enabled: boolean;
  initialized: boolean;
  scope?: AccountScope;
  credentialDir?: string;
  policyFile?: string;
  cwd?: string;
  reason?: string;
  diagnostic?: string;
}

export interface AccountScopeGuardOptions {
  /** Injectable environment for tests; production reads process.env. */
  env?: Record<string, string | undefined>;
  /** Injectable dedicated-launcher exit for tests. Defaults to process.exit. */
  exit?: (code: number) => never | void;
  /** Injectable diagnostics stream. Defaults to process.stderr. */
  stderr?: { write(message: string): unknown };
  /** Command shown when a personal runtime must be relaunched for company work. */
  launcherCommand?: string;
}

export interface AccountScopeGuard {
  readonly enabled: boolean;
  getStatus(): AccountScopeGuardStatus;
  /** Alias useful to status/diagnostics integrations. */
  status(): AccountScopeGuardStatus;
  /** Validate and persist the current runtime selection. */
  validate(ctx: ExtensionContext, previousSessionFile?: string): AccountSelection | null;
}

const ACCOUNT_STATUS_KEY = "pi-account-scope";
const EXIT_CODE = 78;
const SCOPES = new Set<AccountScope>(["personal", "company"]);

/**
 * Register the guard only for a dedicated scoped launcher invocation. An
 * ordinary Pi extension load intentionally remains unchanged: generic
 * extensions cannot reliably intercept every model or SDK request.
 */
export function registerAccountScopeGuard(
  pi: ExtensionAPI,
  options: AccountScopeGuardOptions = {},
): AccountScopeGuard | null {
  const env = options.env ?? process.env;
  if (env.PI_ACCOUNT_LAUNCHER !== "1") return null;

  const state = createGuardState(pi, env, options);
  const guard: AccountScopeGuard = {
    enabled: true,
    getStatus: () => ({ ...state.status }),
    status: () => ({ ...state.status }),
    validate: (ctx, previousSessionFile) => ensureRuntime(state, ctx, previousSessionFile, "validate"),
  };

  pi.on("session_start", (event, ctx) => {
    ensureRuntime(state, ctx, (event as SessionStartEvent).previousSessionFile, "session_start");
  });

  pi.on("before_agent_start", (_event, ctx) => {
    ensureModelProvider(state, ctx, "before_agent_start");
    ensureRuntime(state, ctx, undefined, "before_agent_start");
  });

  pi.on("before_provider_request", (_event, ctx) => {
    // Pi can resolve auth/headers before this hook. Keep this as a runtime
    // consistency diagnostic, while launcher preflight remains fail-closed.
    ensureModelProvider(state, ctx, "before_provider_request");
    ensureRuntime(state, ctx, undefined, "before_provider_request");
  });

  pi.on("model_select", (event) => {
    const provider = (event as { model?: { provider?: unknown } }).model?.provider;
    if (typeof provider === "string" && provider !== "openai-codex") {
      failClosed(state, `model_select: provider '${provider}' is not allowed for scoped ChatGPT OAuth`);
    }
  });

  pi.on("session_before_fork", (_event, ctx) => {
    ensureRuntime(state, ctx, undefined, "session_before_fork");
  });

  pi.on("session_before_switch", (event, ctx) => {
    return beforeSwitch(state, event as SessionBeforeSwitchEvent, ctx);
  });

  return guard;
}

/** Format the stable relaunch instruction used by switch diagnostics. */
export function formatCompanyResumeInstruction(
  sessionFile: string | undefined,
  launcherCommand = "pi-scoped",
  policyFile?: string,
): string {
  const command = launcherCommand.trim() || "pi-scoped";
  const config = policyFile ? ` --config ${quoteForDiagnostic(policyFile)}` : "";
  if (!sessionFile) return `${command}${config} --company --`;
  return `${command}${config} --company --session ${quoteForDiagnostic(sessionFile)} --`;
}

interface GuardState {
  pi: ExtensionAPI;
  env: Record<string, string | undefined>;
  options: AccountScopeGuardOptions;
  startupScope?: AccountScope;
  providerScope?: AccountScope;
  policyFile?: string;
  credentialDir?: string;
  policy?: any;
  startupError?: string;
  runtimeScope?: AccountScope;
  runtimeCredentialDir?: string;
  runtimeSessionFile?: string;
  status: AccountScopeGuardStatus;
}

function createGuardState(
  pi: ExtensionAPI,
  env: Record<string, string | undefined>,
  options: AccountScopeGuardOptions,
): GuardState {
  const state: GuardState = {
    pi,
    env,
    options,
    status: { enabled: true, initialized: false },
  };

  const rawScope = nonEmpty(env.PI_ACCOUNT_SCOPE);
  const rawProviderScope = nonEmpty(env.PI_ACCOUNT_PROVIDER_SCOPE);
  state.startupScope = parseScope(rawScope, "PI_ACCOUNT_SCOPE", state);
  state.providerScope = parseScope(rawProviderScope, "PI_ACCOUNT_PROVIDER_SCOPE", state);
  if (state.startupScope === undefined) {
    state.startupError ??= "PI_ACCOUNT_SCOPE is required for a scoped launcher";
  }
  if (state.providerScope === "company" && state.startupScope !== "company") {
    state.startupError ??= "PI_ACCOUNT_PROVIDER_SCOPE=company requires PI_ACCOUNT_SCOPE=company";
  }

  const rawPolicyFile = nonEmpty(env.PI_ACCOUNT_POLICY_FILE);
  const rawCredentialDir = nonEmpty(env.PI_CODING_AGENT_DIR);
  if (!rawPolicyFile) state.startupError ??= "PI_ACCOUNT_POLICY_FILE is required for a scoped launcher";
  if (!rawCredentialDir) state.startupError ??= "PI_CODING_AGENT_DIR is required for a scoped launcher";

  if (rawPolicyFile) {
    try {
      state.policyFile = canonicalPath(rawPolicyFile);
    } catch (error) {
      state.startupError ??= `Account policy path is unavailable: ${errorMessage(error)}`;
    }
  }
  if (rawCredentialDir) {
    try {
      state.credentialDir = canonicalPath(rawCredentialDir);
    } catch (error) {
      state.startupError ??= `Selected account directory is unavailable: ${errorMessage(error)}`;
    }
  }
  if (state.policyFile) {
    try {
      state.policy = loadAccountPolicy(state.policyFile);
    } catch (error) {
      state.startupError ??= errorMessage(error);
    }
  }

  state.status = {
    enabled: true,
    initialized: false,
    ...(state.startupScope ? { scope: state.startupScope } : {}),
    ...(state.credentialDir ? { credentialDir: state.credentialDir } : {}),
    ...(state.policyFile ? { policyFile: state.policyFile } : {}),
    ...(state.startupError ? { diagnostic: sanitizeDiagnostic(state.startupError) } : {}),
  };
  return state;
}

function parseScope(
  value: string | undefined,
  name: string,
  state: GuardState,
): AccountScope | undefined {
  if (value === undefined) return undefined;
  if (!SCOPES.has(value as AccountScope)) {
    state.startupError ??= `${name} must be 'personal' or 'company'`;
    return undefined;
  }
  return value as AccountScope;
}

function ensureRuntime(
  state: GuardState,
  ctx: ExtensionContext,
  previousSessionFile: string | undefined,
  phase: string,
): AccountSelection | null {
  if (!state.status.enabled) return null;

  try {
    verifyFrozenProfile(state);
    if (!state.policy || !state.startupScope || !state.policyFile || !state.credentialDir) {
      throw new Error(state.startupError ?? "Scoped launcher profile is incomplete");
    }

    const sessionFile = ctx.sessionManager.getSessionFile();
    const currentMetadata = sessionFile ? readAccountSessionMetadata(sessionFile) : {};
    const previousMetadata = previousSessionFile && previousSessionFile !== sessionFile
      ? readAccountSessionMetadata(previousSessionFile)
      : {};
    const cwd = currentMetadata.cwd ?? nonEmpty(ctx.cwd);
    if (!cwd) throw new Error("Pi session cwd is unavailable");

    const selection = resolveAccountSelection({
      policy: state.policy,
      cwd,
      // The frozen launcher scope is the parent scope for this Pi process. It
      // carries company scope through new sessions and descendants.
      parentScope: state.runtimeScope ?? state.startupScope ?? previousMetadata.scope,
      persistedScope: stickyScope(currentMetadata.scope, previousMetadata.scope),
      forceCompany: state.env.PI_ACCOUNT_FORCE_COMPANY === "1",
    }) as AccountSelection;

    if (selection.scope !== state.startupScope) {
      const requested = selection.scope === "company" ? "company" : "personal";
      throw new Error(
        `Selected session requires ${requested} scope (${selection.reason}); relaunch with the matching account profile`,
      );
    }
    if (canonicalPath(selection.credentialDir) !== state.credentialDir) {
      throw new Error("Resolved account directory does not match the frozen launcher profile");
    }
    const upgradingPersonalToCompany = currentMetadata.scope === "personal" && selection.scope === "company";
    if (
      currentMetadata.credentialDir &&
      canonicalPath(currentMetadata.credentialDir) !== state.credentialDir &&
      !upgradingPersonalToCompany
    ) {
      throw new Error("Persisted account directory does not match the frozen launcher profile");
    }
    if (currentMetadata.policyFile && canonicalPath(currentMetadata.policyFile) !== state.policyFile) {
      throw new Error("Persisted account policy does not match the frozen launcher profile");
    }
    assertDirectoryAvailable(state.credentialDir, selection.scope);

    if (sessionFile) {
      persistSelectionInPi(state.pi, sessionFile, currentMetadata, selection);
    } else if (phase !== "session_start") {
      throw new Error("Pi session file is unavailable before a model request");
    }

    state.runtimeScope = state.runtimeScope ?? selection.scope;
    state.runtimeCredentialDir = state.runtimeCredentialDir ?? selection.credentialDir;
    state.runtimeSessionFile = sessionFile ?? state.runtimeSessionFile;
    state.status = {
      enabled: true,
      initialized: true,
      scope: state.runtimeScope,
      credentialDir: state.runtimeCredentialDir,
      policyFile: selection.policyFile,
      cwd: selection.cwd,
      reason: selection.reason,
    };
    setVisibleStatus(ctx, state.status);
    return selection;
  } catch (error) {
    const message = `${phase}: ${errorMessage(error)}`;
    state.status = { ...state.status, diagnostic: sanitizeDiagnostic(message) };
    setVisibleStatus(ctx, state.status);
    failClosed(state, message);
    return null;
  }
}

function ensureModelProvider(state: GuardState, ctx: ExtensionContext, phase: string): void {
  const provider = ctx.model?.provider;
  if (typeof provider === "string" && provider !== "openai-codex") {
    const message = `${phase}: provider '${provider}' is not allowed for scoped ChatGPT OAuth`;
    state.status = { ...state.status, diagnostic: sanitizeDiagnostic(message) };
    setVisibleStatus(ctx, state.status);
    failClosed(state, message);
  }
}

function beforeSwitch(
  state: GuardState,
  event: SessionBeforeSwitchEvent,
  ctx: ExtensionContext,
): { cancel: true } | undefined {
  if (!state.status.enabled) return undefined;

  try {
    // Validate the current runtime before deciding whether a target can be
    // entered. This also records the current marker before a switch.
    ensureRuntime(state, ctx, undefined, "session_before_switch");
    if (!event.targetSessionFile || !state.policy || !state.startupScope) return undefined;

    const target = readAccountSessionMetadata(event.targetSessionFile);
    const targetCwd = target.cwd ?? nonEmpty(ctx.cwd);
    if (!targetCwd) throw new Error("Target Pi session cwd is unavailable");
    const selection = resolveAccountSelection({
      policy: state.policy,
      cwd: targetCwd,
      parentScope: state.runtimeScope ?? state.startupScope,
      persistedScope: stickyScope(target.scope),
      forceCompany: state.env.PI_ACCOUNT_FORCE_COMPANY === "1",
    }) as AccountSelection;

    if (state.runtimeScope === "personal" && selection.scope === "company") {
      const instruction = formatCompanyResumeInstruction(
        event.targetSessionFile,
        state.options.launcherCommand ?? nonEmpty(state.env.PI_ACCOUNT_LAUNCHER_COMMAND) ?? "pi-scoped",
        state.policyFile,
      );
      const message = `Target session requires company account scope. ${instruction}`;
      state.status = { ...state.status, diagnostic: sanitizeDiagnostic(message) };
      notifySwitchDiagnostic(ctx, message);
      return { cancel: true };
    }
    if (selection.scope !== state.startupScope) {
      const message = `Target session requires ${selection.scope} account scope; relaunch with the matching account profile`;
      state.status = { ...state.status, diagnostic: sanitizeDiagnostic(message) };
      notifySwitchDiagnostic(ctx, message);
      return { cancel: true };
    }
    return undefined;
  } catch (error) {
    const message = `session_before_switch: ${errorMessage(error)}`;
    state.status = { ...state.status, diagnostic: sanitizeDiagnostic(message) };
    notifySwitchDiagnostic(ctx, message);
    return { cancel: true };
  }
}

function verifyFrozenProfile(state: GuardState): void {
  if (state.startupError) throw new Error(state.startupError);
  const env = state.env;
  if (env.PI_ACCOUNT_LAUNCHER !== "1") throw new Error("PI_ACCOUNT_LAUNCHER marker changed during runtime");
  if (nonEmpty(env.PI_ACCOUNT_SCOPE) !== state.startupScope) {
    throw new Error("PI_ACCOUNT_SCOPE changed during runtime");
  }
  const providerScope = nonEmpty(env.PI_ACCOUNT_PROVIDER_SCOPE);
  if (providerScope !== undefined && providerScope !== state.providerScope) {
    throw new Error("PI_ACCOUNT_PROVIDER_SCOPE changed during runtime");
  }
  if (providerScope === "company" && state.startupScope !== "company") {
    throw new Error("Provider account scope requires company scope");
  }
  if (!state.policyFile || !state.credentialDir) throw new Error("Scoped launcher profile is incomplete");
  const policyFile = nonEmpty(env.PI_ACCOUNT_POLICY_FILE);
  const credentialDir = nonEmpty(env.PI_CODING_AGENT_DIR);
  if (!policyFile || canonicalPath(policyFile) !== state.policyFile) {
    throw new Error("PI_ACCOUNT_POLICY_FILE changed during runtime");
  }
  if (!credentialDir || canonicalPath(credentialDir) !== state.credentialDir) {
    throw new Error("PI_CODING_AGENT_DIR changed during runtime");
  }
}

function assertDirectoryAvailable(directory: string, scope: AccountScope): void {
  try {
    if (!statSync(directory).isDirectory()) throw new Error("path is not a directory");
  } catch (error) {
    if (scope === "company") {
      throw new Error(`Company credentials/configuration are unavailable at the selected profile (${errorMessage(error)})`);
    }
    throw new Error(`Personal credentials/configuration are unavailable at the selected profile (${errorMessage(error)})`);
  }
}

function persistSelectionInPi(
  pi: ExtensionAPI,
  sessionFile: string,
  currentMetadata: ReturnType<typeof readAccountSessionMetadata>,
  selection: AccountSelection,
): void {
  if (
    currentMetadata.scope === selection.scope &&
    currentMetadata.credentialDir === selection.credentialDir &&
    currentMetadata.policyFile === selection.policyFile &&
    currentMetadata.cwd === selection.cwd
  ) {
    return;
  }
  // Pi's appendEntry updates both the on-disk JSONL and SessionManager's
  // in-memory leaf. Direct appendFileSync would leave fork/lineage metadata
  // invisible to the live runtime.
  pi.appendEntry(ACCOUNT_SESSION_CUSTOM_TYPE, {
    version: ACCOUNT_SESSION_VERSION,
    scope: selection.scope,
    credentialDir: selection.credentialDir,
    policyFile: selection.policyFile,
    cwd: selection.cwd,
  });
}

function failClosed(state: GuardState, message: string): never {
  const diagnostic = sanitizeDiagnostic(message);
  writeDiagnostic(state, diagnostic);
  const exit = state.options.exit ?? ((code: number): never => process.exit(code));
  // A dedicated launcher must terminate before its model request. Tests may
  // inject an exit function that returns; throw afterwards so the fake/core
  // caller still cannot proceed when process.exit is stubbed.
  try {
    exit(EXIT_CODE);
  } catch (error) {
    throw error;
  }
  throw new Error(diagnostic);
}

function writeDiagnostic(state: GuardState, message: string): void {
  try {
    (state.options.stderr ?? process.stderr).write(`[pi-account-scope] ${message}\n`);
  } catch {
    // Diagnostics must not mask the fail-closed path.
  }
}

function setVisibleStatus(ctx: ExtensionContext, status: AccountScopeGuardStatus): void {
  try {
    const text = status.scope
      ? `account: ${status.scope}${status.reason ? ` (${status.reason})` : ""}`
      : status.diagnostic
        ? "account: unavailable"
        : undefined;
    ctx.ui.setStatus(ACCOUNT_STATUS_KEY, text);
  } catch {
    // Print/RPC contexts may not provide a fully functional UI surface.
  }
}

function notifySwitchDiagnostic(ctx: ExtensionContext, message: string): void {
  const diagnostic = sanitizeDiagnostic(message);
  try {
    ctx.ui.notify(diagnostic, "warning");
    ctx.ui.setStatus(ACCOUNT_STATUS_KEY, "account: switch blocked");
  } catch {
    // A cancellation result remains effective without UI.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return sanitizeDiagnostic(error.message);
  return sanitizeDiagnostic(String(error));
}

function sanitizeDiagnostic(value: string): string {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(access[_-]?token|refresh[_-]?token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/auth\.json/gi, "credential file");
}

function quoteForDiagnostic(value: string): string {
  return JSON.stringify(value).replace(/auth\.json/gi, "credential file");
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stickyScope(...scopes: Array<AccountScope | undefined>): AccountScope | undefined {
  if (scopes.includes("company")) return "company";
  return scopes.find((scope): scope is AccountScope => scope === "personal");
}
