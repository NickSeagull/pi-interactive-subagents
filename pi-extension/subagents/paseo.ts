/**
 * Paseo-backed subagent lifecycle.
 *
 * This module deliberately talks to the daemon through the low-level client.
 * The public client is excellent for ordinary UI work, but this extension also
 * needs resume/reconnect-safe waits, and an idempotent local hand-off
 * record.  Paseo owns the child process; this module only owns the request and
 * delivery bookkeeping.
 */
import {
  DaemonClient,
  type DaemonClientConfig,
  type WaitForFinishResult,
} from "@getpaseo/client/internal/daemon-client";
import type { PaseoAgent as AgentSnapshotPayload } from "@getpaseo/client";
import { createRequire } from "node:module";
import {
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  encodePaseoBootstrap,
  PASEO_BOOTSTRAP_READY_ENV,
  type PaseoBootstrapConfig,
} from "./paseo-bootstrap.ts";
// This is a deliberately small, plain-JS policy module so it can also be
// consumed by the standalone launcher. It never reads credential files.
// @ts-ignore JSDoc-typed ESM helper (the package is executed directly by Pi).
import {
  canonicalPath as canonicalAccountPath,
  loadAccountPolicy,
  resolveAccountSelection,
} from "./account-scope.mjs";
// @ts-ignore JSDoc-typed ESM helper; this reads only Pi session metadata.
import { readAccountSessionMetadata } from "./account-session.mjs";
import type { SessionEntry } from "./session.ts";

type JsonObject = Record<string, unknown>;

/** Minimal daemon surface kept injectable for extension and unit tests. */
export interface PaseoDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  createAgent(options: any): Promise<AgentSnapshotPayload | JsonObject>;
  fetchAgent?(agentId: string): Promise<any>;
  waitForAgentUpsert?(agentId: string, predicate: (snapshot: AgentSnapshotPayload) => boolean, timeout?: number): Promise<AgentSnapshotPayload>;
  sendAgentMessage(agentId: string, text: string, options?: any): Promise<void>;
  waitForFinish(agentId: string, timeout?: number): Promise<WaitForFinishResult>;
  cancelAgent(agentId: string): Promise<void>;
  openProject?(cwd: string): Promise<any>;
  getConnectionState?(): { status: string };
}

export interface PaseoBackendOptions {
  parentAgentId: string;
  parentSessionId: string;
  artifactDir: string;
  /** Test hook and an escape hatch for an embedding that already has a client. */
  client?: PaseoDaemonClient;
  daemon?: PaseoDaemonClient;
  clientFactory?: (config: DaemonClientConfig) => PaseoDaemonClient;
  host?: string;
  password?: string;
  connectTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Explicit policy file for sticky personal/company account routing. */
  accountPolicyFile?: string;
  /** Lower bound inherited from the parent session's persisted scope. */
  parentAccountScope?: string;
  /** Explicit company override for a root launched outside company roots. */
  forceCompany?: boolean;
  /** Optional parent Pi session file for durable scope inheritance. */
  parentSessionFile?: string;
}

export interface PaseoBootstrapInput {
  sessionFile?: string;
  tools?: string[];
  deniedTools?: string[];
  systemPrompt?: string;
  systemPromptMode?: string;
  skills?: string[];
}

export interface PaseoSpawnInput {
  id: string;
  name: string;
  task: string;
  agent?: string;
  cwd: string;
  model?: string;
  thinking?: string;
  sessionFile: string;
  activityFile: string;
  sessionMode?: string;
  autoExit?: boolean;
  interactive?: boolean;
  env?: Record<string, string | undefined>;
  configDir?: string;
  extensionPath?: string;
  prompt?: string;
  bootstrap?: PaseoBootstrapInput;
  /** Optional policy/lineage markers supplied by an embedding launcher. */
  accountPolicyFile?: string;
  accountScope?: string;
  credentialDir?: string;
  forceCompany?: boolean;
  [key: string]: unknown;
}

export type AccountScope = "personal" | "company";

export interface PaseoAccountSelection {
  scope: AccountScope;
  credentialDir: string;
  policyFile: string;
  reason: string;
  cwd: string;
  provider: "pi-personal" | "pi-company";
}

export interface PaseoSubagentRecord {
  id: string;
  agentId: string;
  name: string;
  task: string;
  agent?: string;
  cwd: string;
  workspaceId?: string;
  sessionFile: string;
  activityFile?: string;
  startTime: number;
  interactive?: boolean;
  autoExit?: boolean;
  sessionMode?: string;
  model?: string;
  thinking?: string;
  /** Durable account routing metadata. These values are non-secret. */
  accountScope?: AccountScope;
  accountPolicyFile?: string;
  credentialDir?: string;
  provider?: string;
  /** Stable delivery ID, assigned before the parent is woken. */
  deliveryId?: string;
  /** Internal fields are persisted and intentionally tolerated by callers. */
  [key: string]: unknown;
}

export interface PaseoPing {
  name: string;
  message: string;
}

export interface PaseoSubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile: string;
  exitCode: number;
  elapsed: number;
  deliveryId: string;
  ping?: PaseoPing;
  errorMessage?: string;
  /** The daemon's terminal event type when one was observed. */
  terminalEvent?: string;
  [key: string]: unknown;
}

export interface PaseoResumeInput {
  agentId?: string;
  sessionPath?: string;
  message?: string;
  autoExit?: boolean;
  name?: string;
  accountPolicyFile?: string;
  accountScope?: string;
  credentialDir?: string;
  forceCompany?: boolean;
}

type StoredState = "running" | "completed" | "acked";

interface StoredRecord extends PaseoSubagentRecord {
  state: StoredState;
  createdAt: number;
  taskSentAt?: number;
  bootstrapSentAt?: number;
  completionSignalId?: string;
  completionSignalAt?: number;
  result?: PaseoSubagentResult;
  /** Prefix used to distinguish follow-up turns on one native agent. */
  deliveryNamespace?: string;
  signalOffset?: number;
  signalFile?: string;
  initialSessionFile?: string;
  signalBaselineAt?: number;
  legacySignalMtime?: number;
  readyFile?: string;
  pendingSignal?: TerminalSignal;
  bootstrap?: PaseoBootstrapInput;
}

interface RecordStore {
  version: 1;
  parentAgentId: string;
  parentSessionId: string;
  records: Record<string, StoredRecord>;
}

interface TerminalSignal {
  kind: "done" | "error" | "ping" | "completed" | "failed" | "canceled";
  id?: string;
  timestamp?: number;
  message?: string;
  name?: string;
  errorMessage?: string;
  turnId?: string;
  raw: JsonObject;
}

interface DaemonTarget {
  host: string;
  url: string;
  socketPath?: string;
  password?: string;
}

interface NormalizedAccountPolicy {
  policyFile: string;
  personalAgentDir: string;
  companyAgentDir: string;
  companyRoots: string[];
  sharedConfigDir?: string;
}

interface AccountContext {
  policy: NormalizedAccountPolicy;
  selection: PaseoAccountSelection;
}

const DEFAULT_HOST = "localhost:6767";
const DEFAULT_TIMEOUT_MS = 15_000;
// A native Pi process can take tens of seconds to fork/rebind its session on a
// cold Jiti start.  Readiness is request-id scoped, so a generous timeout does
// not allow a stale handshake to satisfy a later request.
const BOOTSTRAP_TIMEOUT_MS = 60_000;
const WAIT_RETRY_MS = 300;
const RECORDS_FILENAME = "paseo-subagents.json";
const ACCOUNT_PROVIDERS = new Set(["pi-personal", "pi-company"]);

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function accountProvider(scope: AccountScope): "pi-personal" | "pi-company" {
  return scope === "company" ? "pi-company" : "pi-personal";
}

function scopeFromProvider(value: unknown, _name: string): AccountScope | undefined {
  const provider = stringValue(value);
  if (!provider) return undefined;
  if (provider === "pi-company") return "company";
  if (provider === "pi-personal") return "personal";
  // `pi` is the legacy/unscoped provider and deliberately contributes no
  // account scope. Other providers are not account markers here.
  if (provider === "pi") return undefined;
  return undefined;
}

function scopeFromMarker(value: unknown, name: string): AccountScope | undefined {
  const marker = stringValue(value);
  if (!marker) return undefined;
  if (marker === "company" || marker === "personal") return marker;
  if (marker === "pi-company") return "company";
  if (marker === "pi-personal") return "personal";
  if (marker === "pi") return undefined;
  throw new Error(`${name} must be 'personal' or 'company'`);
}

function labelValue(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const object = asRecord(entry);
      if (stringValue(object?.key) === key || stringValue(object?.name) === key) {
        return object?.value;
      }
    }
    return undefined;
  }
  const labels = asRecord(value);
  return labels?.[key];
}

function markerScopes(values: Array<{ value: unknown; name: string }>): AccountScope | undefined {
  let selected: AccountScope | undefined;
  for (const marker of values) {
    const scope = scopeFromMarker(marker.value, marker.name);
    if (!scope) continue;
    if (scope === "company") selected = "company";
    else if (!selected) selected = "personal";
  }
  return selected;
}

function providerMarker(values: Array<{ value: unknown; name: string }>): string | undefined {
  let selected: string | undefined;
  for (const marker of values) {
    const provider = stringValue(marker.value);
    if (!provider) continue;
    if (!ACCOUNT_PROVIDERS.has(provider) && provider !== "pi") {
      // Scope marker fields accept scope names as well as provider aliases;
      // invalid values are rejected by scopeFromMarker below. Other labels
      // are ignored so unrelated Paseo provider metadata remains harmless.
      continue;
    }
    if (provider === "pi") continue;
    if (provider === "pi-company") selected = provider;
    else if (!selected) selected = provider;
  }
  return selected;
}

function accountPolicyFileFor(
  options: PaseoBackendOptions,
  env: NodeJS.ProcessEnv,
  persisted: PaseoSubagentRecord | undefined,
  input: PaseoSpawnInput | PaseoResumeInput | undefined,
  parent: AgentSnapshotPayload | null,
  parentSessionMetadata: { policyFile?: string } | undefined,
): string | undefined {
  const persistedLabels = asRecord((persisted as any)?.labels);
  const parentLabels = asRecord((parent as any)?.labels);
  return [
    input?.accountPolicyFile,
    stringValue((input as any)?.env?.PI_ACCOUNT_POLICY_FILE),
    options.accountPolicyFile,
    persisted?.accountPolicyFile,
    stringValue(labelValue(persistedLabels, "pi-account-policy-file")),
    stringValue(labelValue(persistedLabels, "pi-account-policy")),
    stringValue(labelValue(parentLabels, "pi-account-policy-file")),
    stringValue(labelValue(parentLabels, "pi-account-policy")),
    parentSessionMetadata?.policyFile,
    env.PI_ACCOUNT_POLICY_FILE,
  ].map(stringValue).find((value): value is string => !!value);
}

function accountScopeMarkers(
  options: PaseoBackendOptions,
  env: NodeJS.ProcessEnv,
  persisted: PaseoSubagentRecord | undefined,
  input: PaseoSpawnInput | PaseoResumeInput | undefined,
  parent: AgentSnapshotPayload | null,
  parentSessionMetadata: { scope?: string } | undefined,
): { scope?: AccountScope; provider?: string; forceCompany: boolean } {
  const persistedLabels = asRecord((persisted as any)?.labels);
  const parentLabels = asRecord((parent as any)?.labels);
  const persistedMarkers = [
    { value: persisted?.accountScope, name: "persisted accountScope" },
    { value: (persisted as any)?.providerScope, name: "persisted providerScope" },
    { value: labelValue(persistedLabels, "pi-account-scope"), name: "persisted pi-account-scope" },
    { value: labelValue(persistedLabels, "pi-account-provider-scope"), name: "persisted pi-account-provider-scope" },
    { value: labelValue(persistedLabels, "pi-account-provider"), name: "persisted pi-account-provider" },
  ];
  const inputMarkers = [
    { value: input?.accountScope, name: "accountScope" },
    { value: (input as any)?.providerScope, name: "providerScope" },
    { value: labelValue(asRecord((input as any)?.labels), "pi-account-scope"), name: "pi-account-scope" },
    { value: (input as any)?.env?.PI_ACCOUNT_SCOPE, name: "PI_ACCOUNT_SCOPE" },
    { value: (input as any)?.env?.PI_ACCOUNT_PROVIDER_SCOPE, name: "PI_ACCOUNT_PROVIDER_SCOPE" },
  ];
  const parentMarkers = [
    { value: options.parentAccountScope, name: "parentAccountScope" },
    { value: labelValue(parentLabels, "pi-account-scope"), name: "parent pi-account-scope" },
    { value: labelValue(parentLabels, "pi-account-provider-scope"), name: "parent pi-account-provider-scope" },
    { value: labelValue(parentLabels, "pi-account-provider"), name: "parent pi-account-provider" },
    { value: parentSessionMetadata?.scope, name: "parent session account scope" },
    { value: env.PI_ACCOUNT_SCOPE, name: "PI_ACCOUNT_SCOPE" },
    { value: env.PI_ACCOUNT_PROVIDER_SCOPE, name: "PI_ACCOUNT_PROVIDER_SCOPE" },
  ];
  const providers = [
    { value: persisted?.provider, name: "persisted provider" },
    { value: (persisted as any)?.providerScope, name: "persisted providerScope" },
    { value: labelValue(persistedLabels, "pi-account-provider"), name: "persisted pi-account-provider" },
    { value: parent?.provider, name: "parent provider" },
    { value: labelValue(parentLabels, "pi-account-provider"), name: "parent pi-account-provider" },
    { value: input && (input as any).provider, name: "provider" },
  ];
  const scope = markerScopes([...persistedMarkers, ...inputMarkers, ...parentMarkers]);
  const provider = providerMarker(providers);
  let forceCompany = !!options.forceCompany || !!(input as any)?.forceCompany;
  const forceMarker = env.PI_ACCOUNT_FORCE_COMPANY;
  if (forceMarker !== undefined && forceMarker !== "" && forceMarker !== "0" && forceMarker.toLowerCase() !== "false") {
    if (forceMarker !== "1" && forceMarker.toLowerCase() !== "true") {
      throw new Error("PI_ACCOUNT_FORCE_COMPANY must be true or false");
    }
    forceCompany = true;
  }
  const parentProviderScope = scopeFromProvider(parent?.provider, "parent provider");
  const providerScope = scopeFromProvider(provider, "provider");
  const combinedScope = markerScopes([
    { value: parentProviderScope, name: "parent provider" },
    { value: providerScope, name: "provider" },
  ]);
  return {
    scope: markerScopes([
      { value: scope, name: "account scope" },
      { value: combinedScope, name: "provider scope" },
    ]),
    provider,
    forceCompany,
  };
}

function snapshotOf(value: unknown): AgentSnapshotPayload | null {
  const object = asRecord(value);
  const candidate = asRecord(object?.agent) ?? object;
  if (!candidate || typeof candidate.id !== "string" || typeof candidate.provider !== "string") {
    return null;
  }
  return candidate as unknown as AgentSnapshotPayload;
}

function safePath(value: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function canonicalPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    try {
      return realpathSync(value);
    } catch {
      return resolve(value);
    }
  }
}

function normalizeHost(raw: string): { host: string; password?: string; ipc?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("unix://") || trimmed.startsWith("pipe://") || trimmed.startsWith("/")) {
    const path = trimmed.startsWith("unix://") || trimmed.startsWith("pipe://")
      ? trimmed.slice(trimmed.indexOf("://") + 3)
      : trimmed;
    return path ? { host: trimmed, ipc: safePath(path) } : null;
  }

  if (trimmed.startsWith("tcp://")) {
    try {
      const parsed = new URL(trimmed);
      const host = parsed.host;
      if (!host) return null;
      const tls = parsed.searchParams.get("ssl") === "true" || parsed.protocol === "tcps:";
      return {
        host: `${tls ? "wss" : "ws"}://${host}/ws`,
        ...(parsed.searchParams.get("password") ? { password: parsed.searchParams.get("password")! } : {}),
      };
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    try {
      const parsed = new URL(trimmed);
      if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/ws";
      return { host: parsed.toString() };
    } catch {
      return null;
    }
  }

  if (/^\d+$/.test(trimmed)) return { host: `ws://127.0.0.1:${trimmed}/ws` };
  if (!trimmed.includes(":")) return null;
  return { host: `ws://${trimmed}/ws` };
}

function readJsonFile(path: string): JsonObject | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return asRecord(value);
  } catch {
    return null;
  }
}

/** Resolve the same target order as the Paseo CLI, without importing server internals. */
export function resolvePaseoDaemonTargets(
  env: NodeJS.ProcessEnv = process.env,
  explicitHost?: string,
): DaemonTarget[] {
  const home = safePath(env.PASEO_HOME?.trim() || join(homedir(), ".paseo"));
  const pid = readJsonFile(join(home, "paseo.pid"));
  const config = readJsonFile(join(home, "config.json"));
  const daemonConfig = asRecord(config?.daemon);
  // An explicit host is an operator choice. Do not silently connect to a
  // different daemon when that target is unavailable; this is especially
  // important for a parent whose child belongs to a separate Paseo home.
  const selectedHost = explicitHost?.trim() || env.PASEO_HOST?.trim();
  const rawCandidates = selectedHost
    ? [selectedHost]
    : [
        env.PASEO_LISTEN,
        stringValue(pid?.listen),
        stringValue(pid?.sockPath),
        stringValue(daemonConfig?.listen),
        DEFAULT_HOST,
      ].filter((value): value is string => !!value && !!value.trim());
  const seen = new Set<string>();
  const targets: DaemonTarget[] = [];
  for (const raw of rawCandidates) {
    const normalized = normalizeHost(raw);
    if (!normalized) continue;
    const key = `${normalized.host}|${normalized.ipc ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      host: raw,
      url: normalized.ipc ? "ws://localhost/ws" : normalized.host,
      ...(normalized.ipc ? { socketPath: normalized.ipc } : {}),
      ...(normalized.password ? { password: normalized.password } : {}),
    });
  }
  return targets;
}

function createNodeWebSocketFactory(socketPath?: string): NonNullable<DaemonClientConfig["webSocketFactory"]> {
  let Constructor: any;
  try {
    const require = createRequire(import.meta.url);
    const module = require("ws");
    Constructor = module.WebSocket ?? module.default ?? module;
  } catch {
    Constructor = (globalThis as any).WebSocket;
  }
  if (!Constructor) throw new Error("Paseo requires a WebSocket implementation in this runtime");
  return (url, options) => new Constructor(url, options?.protocols, {
    headers: options?.headers,
    ...(socketPath ? { socketPath } : {}),
  }) as any;
}

function clientIdFor(parentAgentId: string): string {
  const compact = parentAgentId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "parent";
  return `pi-subagents-${compact}-${randomUUID().slice(0, 8)}`;
}

function safeTargetLabel(raw: string): string {
  let sanitized = raw;
  try {
    if (/^(?:tcp|tcps|ws|wss):\/\//i.test(raw)) {
      const parsed = new URL(raw);
      parsed.username = "";
      parsed.password = "";
      sanitized = parsed.toString();
    }
  } catch {
    // Fall through to the redaction expressions below for malformed targets.
  }
  return sanitized
    .replace(/(\/\/)[^/\s@]+@/g, "$1")
    .replace(/([?&](?:password|token|secret|auth|key)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]");
}

async function connectDiscoveredClient(options: PaseoBackendOptions): Promise<PaseoDaemonClient> {
  const env = options.env ?? process.env;
  const targets = resolvePaseoDaemonTargets(env, options.host);
  const failures: string[] = [];
  for (const target of targets) {
    const config: DaemonClientConfig = {
      url: target.url,
      clientId: clientIdFor(options.parentAgentId),
      clientType: "cli",
      password: options.password ?? target.password ?? env.PASEO_PASSWORD,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      webSocketFactory: createNodeWebSocketFactory(target.socketPath),
      reconnect: { enabled: true, baseDelayMs: 250, maxDelayMs: 10_000 },
    };
    const client = options.clientFactory?.(config) ?? new DaemonClient(config);
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      const message = safeTargetLabel(error instanceof Error ? error.message : String(error));
      // Hosts are safe to expose; credentials never appear in this summary.
      failures.push(`${safeTargetLabel(target.host)}: ${message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")}`);
    }
  }
  throw new Error(
    `Unable to connect to the Paseo daemon. ${failures.length ? failures.join("; ") : "No daemon target was configured."}`,
  );
}

function storePath(artifactDir: string): string {
  return join(artifactDir, RECORDS_FILENAME);
}

function emptyStore(options: PaseoBackendOptions): RecordStore {
  return {
    version: 1,
    parentAgentId: options.parentAgentId,
    parentSessionId: options.parentSessionId,
    records: {},
  };
}

function loadStore(options: PaseoBackendOptions): RecordStore {
  const parsed = readJsonFile(storePath(options.artifactDir));
  if (!parsed || parsed.version !== 1 || parsed.parentAgentId !== options.parentAgentId) {
    return emptyStore(options);
  }
  const records = asRecord(parsed.records);
  if (!records) return emptyStore(options);
  return {
    version: 1,
    parentAgentId: options.parentAgentId,
    parentSessionId: options.parentSessionId,
    records: records as Record<string, StoredRecord>,
  };
}

function persistStore(options: PaseoBackendOptions, store: RecordStore): void {
  mkdirSync(options.artifactDir, { recursive: true });
  const path = storePath(options.artifactDir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store)}\n`, "utf8");
  renameSync(temporary, path);
}

function clearLegacyExitSignal(sessionFile: string | undefined): void {
  if (!sessionFile) return;
  try {
    unlinkSync(`${sessionFile}.exit`);
  } catch {
    // The durable Paseo outbox is authoritative. This compatibility file may
    // be absent or belong to a runtime that does not permit unlinking it.
  }
}

function fileModificationTime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function nativeSessionFile(snapshot: AgentSnapshotPayload | null): string | undefined {
  const persistence = asRecord(snapshot?.persistence);
  const native = stringValue(persistence?.nativeHandle);
  return native && (native.startsWith("/") || native.startsWith("~")) ? safePath(native) : undefined;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function sessionSummary(paths: Array<string | undefined>): string | undefined {
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    try {
      const entries = readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SessionEntry);
      // ctx.abort() is reported by some Pi versions as a synthetic assistant
      // error after the real final message. Skip errored/aborted assistant
      // entries so an explicit subagent_done still returns the child's work.
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index] as any;
        if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
        const stopReason = entry.message.stopReason;
        const text = Array.isArray(entry.message.content)
          ? entry.message.content
              .filter((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim())
              .map((block: any) => block.text.trim())
              .join("\n")
              .trim()
          : "";
        if (!text) continue;
        if (stopReason === "error" || stopReason === "aborted" || /^\[System Error\].*aborted/i.test(text)) continue;
        return text;
      }
    } catch {
      // A Pi session may be in the middle of an append. Try the next source.
    }
  }
  return undefined;
}

function buildBootstrapConfig(
  record: PaseoSubagentRecord,
  parentAgentId: string,
  parentSessionId: string,
  input: PaseoSpawnInput | PaseoResumeInput,
  bootstrap: PaseoBootstrapInput | undefined,
  actualSessionFile?: string,
): PaseoBootstrapConfig {
  const resume = input as PaseoResumeInput;
  const spawn = input as PaseoSpawnInput;
  const modelValue = spawn.model ?? record.model;
  const thinkingValue = spawn.thinking ?? record.thinking;
  const targetSessionFile = bootstrap?.sessionFile
    ?? actualSessionFile
    ?? (existsSync(record.sessionFile) ? record.sessionFile : undefined);
  const accountMetadata = record.accountScope && record.accountPolicyFile && record.credentialDir
    ? {
        accountScope: record.accountScope,
        accountPolicyFile: record.accountPolicyFile,
        credentialDir: record.credentialDir,
        providerScope: record.provider === "pi-company" ? "company"
          : record.provider === "pi-personal" ? "personal"
            : record.accountScope,
      }
    : {};
  return {
    version: 1,
    requestId: `${record.id}:${randomUUID()}`,
    ...(targetSessionFile ? { sessionFile: targetSessionFile } : {}),
    tools: bootstrap?.tools,
    deniedTools: bootstrap?.deniedTools,
    systemPrompt: bootstrap?.systemPrompt,
    systemPromptMode:
      bootstrap?.systemPromptMode === "replace" || bootstrap?.systemPromptMode === "append"
        ? bootstrap.systemPromptMode
        : undefined,
    skills: bootstrap?.skills,
    name: record.name,
    agent: record.agent,
    childId: record.id,
    activityFile: record.activityFile,
    autoExit: resume.autoExit !== undefined ? resume.autoExit : record.autoExit,
    interactive: record.interactive,
    model: modelValue
      ? (() => {
          const slash = modelValue!.indexOf("/");
          return slash > 0
            ? { provider: modelValue!.slice(0, slash), id: modelValue!.slice(slash + 1) }
            : undefined;
        })()
      : undefined,
    thinkingLevel: thinkingValue,
    // The bootstrap extension currently ignores unknown fields, but keeping
    // lineage in the payload lets newer companions initialize nested SDK use.
    parentAgentId,
    parentSessionId,
    paseoAgentId: record.agentId,
    ...accountMetadata,
  } as PaseoBootstrapConfig;
}

function encodeBootstrapCommand(config: PaseoBootstrapConfig): string {
  return `/pi-subagent-bootstrap ${encodePaseoBootstrap(config)}`;
}

function signalKind(value: unknown): TerminalSignal["kind"] | undefined {
  const raw = stringValue(value)?.toLowerCase();
  if (raw === "done" || raw === "completed" || raw === "turn_completed") return raw === "turn_completed" ? "completed" : raw;
  if (raw === "error" || raw === "failed" || raw === "turn_failed") return raw === "turn_failed" ? "failed" : raw;
  if (raw === "ping") return "ping";
  if (raw === "canceled" || raw === "cancelled" || raw === "turn_canceled") return "canceled";
  return undefined;
}

function normalizeSignal(raw: JsonObject): TerminalSignal | null {
  const nested = asRecord(raw.payload) ?? asRecord(raw.event) ?? raw;
  const kind = signalKind(raw.type) ?? signalKind(nested.type) ?? signalKind(raw.kind);
  if (!kind) return null;
  const message = stringValue(raw.message) ?? stringValue(nested.message);
  const errorMessage = stringValue(raw.errorMessage) ?? stringValue(raw.error) ?? stringValue(nested.errorMessage) ?? stringValue(nested.error);
  const timestampRaw = raw.timestamp ?? nested.timestamp;
  const timestamp = typeof timestampRaw === "number"
    ? timestampRaw
    : typeof timestampRaw === "string" && Number.isFinite(Date.parse(timestampRaw))
      ? Date.parse(timestampRaw)
      : undefined;
  return {
    kind,
    id: stringValue(raw.id) ?? stringValue(raw.eventId) ?? stringValue(nested.id),
    timestamp,
    message,
    name: stringValue(raw.name) ?? stringValue(nested.name),
    errorMessage,
    turnId: stringValue(raw.turnId) ?? stringValue(nested.turnId),
    raw,
  };
}

function readCompleteLines(path: string, offset: number): { lines: string[]; offset: number } {
  try {
    const data = readFileSync(path);
    if (offset > data.length) offset = 0;
    const remainder = data.subarray(offset);
    const lastNewline = remainder.lastIndexOf(10);
    if (lastNewline < 0) return { lines: [], offset };
    const complete = remainder.subarray(0, lastNewline + 1).toString("utf8");
    return { lines: complete.split(/\r?\n/).filter(Boolean), offset: offset + lastNewline + 1 };
  } catch {
    return { lines: [], offset };
  }
}

function terminalSignal(signal: TerminalSignal | null): boolean {
  return !!signal && (signal.kind === "done" || signal.kind === "error" || signal.kind === "ping" || signal.kind === "completed" || signal.kind === "failed");
}

function isProviderPi(snapshot: AgentSnapshotPayload | null): boolean {
  return !!snapshot?.provider && (snapshot.provider === "pi" || ACCOUNT_PROVIDERS.has(snapshot.provider));
}

function waitResultError(result: WaitForFinishResult): string | undefined {
  return result.error?.trim() || result.final?.lastError?.trim() || undefined;
}

function summaryFromWait(result: WaitForFinishResult): string | undefined {
  const summary = result.lastMessage?.trim();
  if (!summary || /(?:operation was aborted|stopReason\s*=\s*(?:error|aborted))/i.test(summary)) return undefined;
  return summary;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Paseo watcher aborted"));
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Paseo watcher aborted"));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitForBootstrapReady(
  path: string | undefined,
  requestId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!path) return;
  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Paseo bootstrap watcher aborted");
    if (existsSync(path)) {
      const ready = readJsonFile(path);
      // A readiness file without this request's nonce is stale (or malformed)
      // and must never release a later bootstrap.
      if (ready?.requestId !== requestId) {
        await sleepWithSignal(50, signal);
        continue;
      }
      if (ready?.ok === false) throw new Error(stringValue(ready.error) ?? "Paseo child bootstrap failed");
      if (ready?.ok === true) return;
    }
    await sleepWithSignal(50, signal);
  }
  throw new Error("Timed out waiting for Paseo Pi bootstrap readiness");
}

export class PaseoBackend {
  private readonly options: PaseoBackendOptions;
  private readonly daemon: PaseoDaemonClient;
  private store: RecordStore;
  private parentSnapshot: AgentSnapshotPayload | null = null;
  private closed = false;
  private readonly closeController = new AbortController();

  private constructor(options: PaseoBackendOptions, daemon: PaseoDaemonClient) {
    this.options = options;
    this.daemon = daemon;
    this.store = loadStore(options);
  }

  /**
   * Resolve account routing from the named policy and all available lineage
   * markers. This method is intentionally synchronous: the policy helper only
   * reads the explicitly named policy JSON, and callers need the selected
   * credential directory before deriving session paths.
   */
  accountFor(
    cwd: string,
    persistedRecord?: PaseoSubagentRecord,
    input?: PaseoSpawnInput | PaseoResumeInput,
  ): PaseoAccountSelection | undefined {
    const env = this.options.env ?? process.env;
    const parentSessionMetadata = this.options.parentSessionFile
      ? readAccountSessionMetadata(this.options.parentSessionFile) as { scope?: string; policyFile?: string }
      : undefined;
    const markers = accountScopeMarkers(this.options, env, persistedRecord, input, this.parentSnapshot, parentSessionMetadata);
    const policyFile = accountPolicyFileFor(this.options, env, persistedRecord, input, this.parentSnapshot, parentSessionMetadata);
    if (!policyFile) {
      if (markers.scope || markers.provider || markers.forceCompany) {
        throw new Error(
          `Paseo ${markers.scope ?? "account"} scope requires PI_ACCOUNT_POLICY_FILE or PaseoBackendOptions.accountPolicyFile; refusing to choose personal credentials without account configuration.`,
        );
      }
      return undefined;
    }

    let policy: NormalizedAccountPolicy;
    try {
      policy = loadAccountPolicy(policyFile) as NormalizedAccountPolicy;
    } catch (error) {
      // Do not include parsed policy data or any credential path contents in
      // the diagnostic. The policy path itself is operator configuration.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to load Paseo account policy '${policyFile}': ${message}`, { cause: error });
    }
    const rawSelection = resolveAccountSelection({
      policy,
      cwd,
      parentScope: markers.scope,
      persistedScope: undefined,
      forceCompany: markers.forceCompany,
    }) as {
      scope: AccountScope;
      credentialDir: string;
      policyFile: string;
      reason: string;
      cwd: string;
    };
    return {
      ...rawSelection,
      provider: accountProvider(rawSelection.scope),
    };
  }

  /** Public seed-path API used by the Pi extension before it creates a child. */
  async resolveAccountForCwd(cwd: string): Promise<PaseoAccountSelection | undefined> {
    return this.accountFor(cwd);
  }

  private accountContextFor(
    cwd: string,
    persistedRecord?: PaseoSubagentRecord,
    input?: PaseoSpawnInput | PaseoResumeInput,
    sessionFileOverride?: string,
  ): AccountContext | undefined {
    let effectiveCwd = cwd;
    let effectiveRecord = persistedRecord;
    let sessionMetadata: {
      scope?: AccountScope;
      cwd?: string;
      credentialDir?: string;
      policyFile?: string;
    } | undefined;
    const metadataSessionFile = sessionFileOverride
      ?? persistedRecord?.sessionFile
      ?? ((input as PaseoSpawnInput | undefined)?.bootstrap?.sessionFile);
    if (metadataSessionFile) {
      const metadata = readAccountSessionMetadata(metadataSessionFile) as typeof sessionMetadata;
      sessionMetadata = metadata;
      // The Pi session header is the authoritative cwd for account
      // classification after a fork or native session recreation. Keep a
      // company marker from either the local record or session metadata.
      if (metadata?.cwd) effectiveCwd = metadata.cwd;
      if (!effectiveRecord && input && "id" in input && (metadata?.scope || metadata?.policyFile || metadata?.credentialDir)) {
        // A seeded fork may carry durable account metadata before Paseo has
        // written its local record. Treat that session entry as persisted
        // lineage while resolving the provider for the native create call.
        effectiveRecord = {
          id: (input as PaseoSpawnInput).id,
          agentId: "seeded-session",
          name: (input as PaseoSpawnInput).name,
          task: (input as PaseoSpawnInput).task,
          cwd,
          sessionFile: metadataSessionFile,
          startTime: Date.now(),
          accountScope: metadata?.scope,
          accountPolicyFile: metadata?.policyFile,
          credentialDir: metadata?.credentialDir,
          provider: metadata?.scope ? accountProvider(metadata.scope) : undefined,
        };
      }
      if (!effectiveRecord) effectiveRecord = persistedRecord;
      if (!effectiveRecord) {
        // No recognized metadata: accountFor below still classifies the cwd
        // and the parent markers normally.
      } else {
        const baseRecord = effectiveRecord;
        const company = baseRecord.accountScope === "company" || metadata?.scope === "company";
        effectiveRecord = {
          ...baseRecord,
          ...(company
            ? { accountScope: "company" as const }
            : metadata?.scope
              ? { accountScope: metadata.scope }
              : {}),
          ...(company
            ? {
                accountPolicyFile: metadata?.scope === "company"
                  ? metadata.policyFile ?? baseRecord.accountPolicyFile
                  : baseRecord.accountPolicyFile ?? metadata?.policyFile,
                credentialDir: metadata?.scope === "company"
                  ? metadata.credentialDir ?? baseRecord.credentialDir
                  : baseRecord.credentialDir ?? metadata?.credentialDir,
              }
            : {
                ...(metadata?.policyFile && !baseRecord.accountPolicyFile ? { accountPolicyFile: metadata.policyFile } : {}),
                ...(metadata?.credentialDir && !baseRecord.credentialDir ? { credentialDir: metadata.credentialDir } : {}),
              }),
        };
      }
    }
    const selection = this.accountFor(effectiveCwd, effectiveRecord, input);
    if (!selection) return undefined;
    if (sessionMetadata?.policyFile && canonicalAccountPath(sessionMetadata.policyFile) !== canonicalAccountPath(selection.policyFile)) {
      throw new Error("Persisted Pi account policy differs from the selected Paseo policy; refusing to launch or resume.");
    }
    // A fresh seeded child may legitimately promote a personal parent when
    // its own session cwd is company-scoped. The child has not launched a
    // runtime yet, so selecting the company profile is safe. An existing
    // record (including resume/recreation) must still reject this mismatch:
    // Paseo cannot switch credentials in a live Pi process.
    const allowFreshPersonalSeedPromotion = !persistedRecord
      && sessionMetadata?.scope === "personal"
      && selection.scope === "company";
    if (
      sessionMetadata?.credentialDir
      && canonicalAccountPath(sessionMetadata.credentialDir) !== canonicalAccountPath(selection.credentialDir)
      && !allowFreshPersonalSeedPromotion
    ) {
      throw new Error("Persisted Pi credential directory differs from the selected account; refusing to switch credentials in place.");
    }
    const policy = loadAccountPolicy(selection.policyFile) as NormalizedAccountPolicy;
    return { policy, selection };
  }

  private async prepareAccountProfile(context: AccountContext | undefined): Promise<void> {
    if (!context) return;
    let profileModule: any;
    try {
      profileModule = await import("./account-profile.mjs");
    } catch (error) {
      throw new Error(
        "Paseo account profile helper is unavailable; refusing to launch without isolated credentials",
        { cause: error },
      );
    }
    if (typeof profileModule.prepareAccountProfile !== "function") {
      throw new Error("Paseo account profile helper does not export prepareAccountProfile; refusing to launch");
    }
    await profileModule.prepareAccountProfile(context.selection, context.policy);
  }

  private assertAccountCompatibility(
    record: PaseoSubagentRecord,
    snapshot: AgentSnapshotPayload | null,
    context: AccountContext | undefined,
    phase: "spawn" | "resume",
  ): void {
    const recordScope = scopeFromMarker(record.accountScope, "persisted accountScope");
    const recordProvider = stringValue(record.provider);
    const selected = context?.selection;

    if (selected) {
      if (recordScope && recordScope !== selected.scope) {
        throw new Error(
          `Cannot ${phase} Paseo agent ${record.agentId}: persisted ${recordScope} account cannot switch to ${selected.scope} in place; recreate it under ${selected.provider}.`,
        );
      }
      if (recordProvider && ACCOUNT_PROVIDERS.has(recordProvider) && recordProvider !== selected.provider) {
        throw new Error(
          `Cannot ${phase} Paseo agent ${record.agentId}: persisted provider '${recordProvider}' does not match selected provider '${selected.provider}'.`,
        );
      }
      if (record.accountPolicyFile && canonicalAccountPath(record.accountPolicyFile) !== canonicalAccountPath(selected.policyFile)) {
        throw new Error(
          `Cannot ${phase} Paseo agent ${record.agentId}: persisted account policy differs from the current policy; recreate the agent under the selected profile.`,
        );
      }
      if (record.credentialDir && canonicalAccountPath(record.credentialDir) !== canonicalAccountPath(selected.credentialDir)) {
        throw new Error(
          `Cannot ${phase} Paseo agent ${record.agentId}: persisted credential directory differs from the selected account; recreate the agent instead of changing loaded credentials in place.`,
        );
      }
      if (snapshot?.provider && snapshot.provider !== selected.provider) {
        throw new Error(
          `Cannot ${phase} Paseo agent ${record.agentId}: Paseo reports provider '${snapshot.provider}', expected '${selected.provider}'; refusing an in-place account switch.`,
        );
      }
    } else if (
      recordScope ||
      (recordProvider && ACCOUNT_PROVIDERS.has(recordProvider)) ||
      (snapshot?.provider && ACCOUNT_PROVIDERS.has(snapshot.provider))
    ) {
      throw new Error(
        `Cannot ${phase} Paseo agent ${record.agentId}: persisted account scope requires an account policy; refusing to fall back to personal credentials.`,
      );
    }
  }

  static async create(options: PaseoBackendOptions): Promise<PaseoBackend> {
    if (!options.parentAgentId?.trim()) throw new Error("Paseo parent agent ID is required");
    if (!options.parentSessionId?.trim()) throw new Error("Paseo parent session ID is required");
    mkdirSync(options.artifactDir, { recursive: true });
    const daemon = options.client ?? options.daemon ?? await connectDiscoveredClient(options);
    try {
      // An injected client may already be connected; DaemonClient.connect is
      // idempotent and the small structural fake used by tests generally is.
      await daemon.connect();
      const backend = new PaseoBackend(options, daemon);
      await backend.validateParent();
      return backend;
    } catch (error) {
      await daemon.close().catch(() => undefined);
      throw error;
    }
  }

  private async validateParent(): Promise<void> {
    if (!this.daemon.fetchAgent) return;
    const fetched = await this.daemon.fetchAgent(this.options.parentAgentId);
    const snapshot = snapshotOf(fetched);
    if (!snapshot) throw new Error(`Paseo parent agent not found: ${this.options.parentAgentId}`);
    if (!isProviderPi(snapshot)) {
      throw new Error(`Paseo subagents require a Pi parent agent; received provider '${snapshot.provider}'.`);
    }
    this.parentSnapshot = snapshot;
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error("Paseo backend is closed");
    const state = this.daemon.getConnectionState?.();
    if (state?.status === "connected") return;
    await this.daemon.connect();
  }

  private async workspaceFor(cwd: string): Promise<string | undefined> {
    const parentCwd = this.parentSnapshot?.cwd;
    // Omitting workspaceId is meaningful: the daemon then resolves the child
    // to the caller's exact workspace and cwd. For every other cwd, ask the
    // daemon to open that directory explicitly. This keeps subdirectories and
    // sibling checkouts from silently inheriting the parent's cwd.
    if (!parentCwd || canonicalPath(parentCwd) === canonicalPath(cwd)) return undefined;
    if (!this.daemon.openProject) throw new Error("Paseo client cannot place a child in another workspace");
    const opened = await this.daemon.openProject(cwd);
    const workspace = asRecord(opened?.workspace) ?? opened;
    const id = stringValue(workspace?.id) ?? stringValue(opened?.workspaceId);
    if (!id) throw new Error(`Paseo did not return a workspace for ${cwd}`);
    return id;
  }

  private async refreshSnapshot(agentId: string): Promise<AgentSnapshotPayload | null> {
    if (!this.daemon.fetchAgent) return null;
    try {
      return snapshotOf(await this.daemon.fetchAgent(agentId));
    } catch {
      return null;
    }
  }

  private async waitForNativeSession(agentId: string, fallback?: string): Promise<string | undefined> {
    const current = await this.refreshSnapshot(agentId);
    const direct = nativeSessionFile(current);
    if (direct) return direct;
    if (this.daemon.waitForAgentUpsert) {
      try {
        const upserted = await this.daemon.waitForAgentUpsert(agentId, (snapshot) => !!nativeSessionFile(snapshot), 15_000);
        return nativeSessionFile(upserted) ?? fallback;
      } catch {
        // Some old daemons omit the persistence handle from agent updates.
      }
    }
    return fallback;
  }

  private signalFileFor(record: StoredRecord): string {
    return record.signalFile ?? `${record.sessionFile}.paseo-events.jsonl`;
  }

  private readSignal(record: StoredRecord): TerminalSignal | null {
    if (record.pendingSignal && terminalSignal(record.pendingSignal)) return record.pendingSignal;
    const path = this.signalFileFor(record);
    const oldOffset = record.signalOffset ?? 0;
    const read = readCompleteLines(path, oldOffset);
    if (read.offset !== oldOffset) {
      record.signalOffset = read.offset;
      record.signalFile = path;
      const parsed = read.lines.map((line) => {
        try { return normalizeSignal(JSON.parse(line) as JsonObject); } catch { return null; }
      }).filter((value): value is TerminalSignal => !!value);
      // Keep the first terminal event after the baseline. A child can receive
      // another UI turn while the parent is offline; the first event belongs
      // to this delegation and must remain the reconciliation watermark.
      const candidate = parsed.find(terminalSignal) ?? null;
      if (candidate) {
        record.pendingSignal = candidate;
        persistStore(this.options, this.store);
        return candidate;
      }
    }
    // Current Paseo Pi children append every terminal hand-off to the durable
    // JSONL log. Keep a guarded compatibility path for older companions and
    // injected hosts that only write `.exit`: durable events are always read
    // first, and resume clears the old file before taking a new watermark.
    const legacyPath = `${record.sessionFile}.exit`;
    try {
      const mtimeMs = statSync(legacyPath).mtimeMs;
      const baseline = record.signalBaselineAt ?? record.startTime;
      if (mtimeMs > baseline && mtimeMs !== record.legacySignalMtime) {
        const legacy = readJsonFile(legacyPath);
        const candidate = legacy ? normalizeSignal(legacy) : null;
        record.legacySignalMtime = mtimeMs;
        if (candidate && terminalSignal(candidate)) {
          record.pendingSignal = candidate;
          persistStore(this.options, this.store);
          return candidate;
        }
        persistStore(this.options, this.store);
      }
    } catch {
      // The durable outbox remains the source of truth when the compatibility
      // sidecar is missing or cannot be read.
    }
    return null;
  }

  private async sendBootstrap(
    record: StoredRecord,
    input: PaseoSpawnInput | PaseoResumeInput,
    bootstrap: PaseoBootstrapInput | undefined,
    actualSessionFile?: string,
  ): Promise<void> {
    const config = buildBootstrapConfig(
      record,
      this.options.parentAgentId,
      this.options.parentSessionId,
      input,
      bootstrap,
      actualSessionFile,
    );
    const requestId = config.requestId ?? `${record.id}:${Date.now()}`;
    await this.daemon.sendAgentMessage(record.agentId, encodeBootstrapCommand(config), {
      messageId: `paseo-bootstrap-${record.agentId}-${record.id}`,
    });
    record.bootstrapSentAt = Date.now();
    record.bootstrap = bootstrap;
    persistStore(this.options, this.store);
    await waitForBootstrapReady(record.readyFile, requestId);
    // The readiness file is written after the target session's fresh
    // session_start hook. Sending the task now is ordered after bootstrap.
  }

  async spawn(input: PaseoSpawnInput): Promise<PaseoSubagentRecord> {
    if (input.cli && input.cli !== "pi") throw new Error("Paseo subagents support Pi agent definitions only.");
    if (!input.id || !input.name || !input.cwd) throw new Error("Paseo spawn requires id, name, and cwd");
    const accountContext = this.accountContextFor(input.cwd, undefined, input);
    const account = accountContext?.selection;
    if (account && input.credentialDir && canonicalAccountPath(input.credentialDir) !== canonicalAccountPath(account.credentialDir)) {
      throw new Error(
        `Paseo child '${input.id}' requested credential directory different from the selected ${account.scope} account; refusing to mix profiles.`,
      );
    }
    // The profile helper validates only the selected canonical credential
    // profile. It runs before any native agent request so a missing company
    // profile can never result in a personal fallback.
    await this.prepareAccountProfile(accountContext);
    const previousLegacyMtime = fileModificationTime(`${input.sessionFile}.exit`);
    clearLegacyExitSignal(input.sessionFile);
    await this.ensureConnected();
    const workspaceId = await this.workspaceFor(input.cwd);

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.env ?? {})) if (value !== undefined) env[key] = value;
    const ambientAgentDir = input.env?.PI_CODING_AGENT_DIR
      ?? this.options.env?.PI_CODING_AGENT_DIR
      ?? process.env.PI_CODING_AGENT_DIR
      ?? join(homedir(), ".pi", "agent");
    const selectedAgentDir = account?.credentialDir ?? input.configDir ?? ambientAgentDir;
    // Paseo's daemon may run with a different ambient environment. Always
    // send the selected profile explicitly in the per-agent launch env.
    env.PI_CODING_AGENT_DIR = canonicalPath(safePath(selectedAgentDir));
    if (account) {
      env.PI_ACCOUNT_SCOPE = account.scope;
      env.PI_ACCOUNT_POLICY_FILE = account.policyFile;
      env.PI_ACCOUNT_LAUNCHER = "1";
      env.PI_ACCOUNT_PROVIDER_SCOPE = account.scope;
    }
    if (input.sessionFile) env.PI_SESSION_DIR = dirname(input.sessionFile);
    env.PI_SUBAGENT_BACKEND = "paseo";
    env.PI_SUBAGENT_ID = input.id;
    env.PI_SUBAGENT_NAME = input.name;
    if (input.agent) env.PI_SUBAGENT_AGENT = input.agent;
    env.PI_SUBAGENT_SESSION = input.sessionFile;
    env.PI_SUBAGENT_ACTIVITY_FILE = input.activityFile;
    const readyFile = join(this.options.artifactDir, "paseo-bootstrap", `${input.id}.json`);
    try { unlinkSync(readyFile); } catch { /* stale readiness is guarded by requestId */ }
    env[PASEO_BOOTSTRAP_READY_ENV] = readyFile;
    if (input.autoExit) env.PI_SUBAGENT_AUTO_EXIT = "1";
    if (input.interactive !== undefined) env.PI_SUBAGENT_INTERACTIVE = input.interactive ? "1" : "0";
    if (input.bootstrap?.tools) env.PI_SUBAGENT_TOOLS = input.bootstrap.tools.join(",");
    if (input.bootstrap?.deniedTools) env.PI_DENY_TOOLS = input.bootstrap.deniedTools.join(",");
    if (input.bootstrap?.skills) env.PI_SUBAGENT_SKILLS = input.bootstrap.skills.join(",");
    env.PI_SUBAGENT_PARENT_AGENT_ID = this.options.parentAgentId;

    const provider = account?.provider ?? "pi";
    const config: JsonObject = {
      provider,
      cwd: input.cwd,
      title: input.name,
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinkingOptionId: input.thinking } : {}),
      ...(input.bootstrap?.systemPrompt ? { systemPrompt: input.bootstrap.systemPrompt } : {}),
    };
    const created = await this.daemon.createAgent({
      config,
      provider,
      cwd: input.cwd,
      env,
      ...(workspaceId ? { workspaceId } : {}),
      callerAgentId: this.options.parentAgentId,
      labels: {
        "pi-subagent-id": input.id,
        "pi-subagent-session": input.sessionFile,
        "pi-subagent-backend": "paseo",
        ...(account ? {
          "pi-account-scope": account.scope,
          "pi-account-policy-file": account.policyFile,
          "pi-account-provider": provider,
          "pi-account-credential-dir": account.credentialDir,
        } : {}),
      },
      idempotencyKey: `pi-subagent:${this.options.parentSessionId}:${input.id}`,
    });
    const snapshot = snapshotOf(created);
    if (!snapshot || !isProviderPi(snapshot)) throw new Error("Paseo did not create a Pi child agent");
    const provisionalRecord = {
      id: input.id,
      agentId: snapshot.id,
      name: input.name,
      task: input.task,
      cwd: input.cwd,
      accountScope: account?.scope,
      accountPolicyFile: account?.policyFile,
      credentialDir: account?.credentialDir,
      provider,
    } as PaseoSubagentRecord;
    this.assertAccountCompatibility(provisionalRecord, snapshot, accountContext, "spawn");
    const initialNative = await this.waitForNativeSession(snapshot.id, nativeSessionFile(snapshot));
    const seeded = input.bootstrap?.sessionFile;
    const selectedSession = seeded ?? initialNative ?? input.sessionFile;
    const selectedLegacyMtime = selectedSession === input.sessionFile
      ? previousLegacyMtime
      : fileModificationTime(`${selectedSession}.exit`);
    if (selectedSession !== input.sessionFile) clearLegacyExitSignal(selectedSession);
    const record: StoredRecord = {
      id: input.id,
      agentId: snapshot.id,
      name: input.name,
      task: input.task,
      agent: input.agent,
      cwd: input.cwd,
      workspaceId: snapshot.workspaceId ?? workspaceId,
      sessionFile: selectedSession,
      initialSessionFile: initialNative,
      activityFile: input.activityFile,
      startTime: Date.now(),
      interactive: input.interactive,
      autoExit: input.autoExit,
      sessionMode: input.sessionMode,
      model: input.model,
      thinking: input.thinking,
      accountScope: account?.scope,
      accountPolicyFile: account?.policyFile,
      credentialDir: account?.credentialDir,
      provider,
      state: "running",
      createdAt: Date.now(),
      signalFile: `${selectedSession}.paseo-events.jsonl`,
      signalOffset: fileSize(`${selectedSession}.paseo-events.jsonl`),
      signalBaselineAt: Date.now(),
      legacySignalMtime: selectedLegacyMtime,
      readyFile,
      bootstrap: input.bootstrap,
    };
    this.store.records[record.id] = record;
    persistStore(this.options, this.store);

    // If the caller seeded a fork, bootstrap switches the Pi runtime to that
    // exact file. A standalone child uses the actual native handle returned by
    // Paseo and never points Pi at the caller's placeholder path.
    await this.sendBootstrap(record, input, input.bootstrap, seeded ? undefined : initialNative);
    record.taskSentAt = Date.now();
    await this.daemon.sendAgentMessage(record.agentId, input.prompt ?? input.task, {
      messageId: `paseo-task-${record.agentId}-${record.id}`,
    });
    persistStore(this.options, this.store);
    return { ...record };
  }

  private resultForSignal(
    record: StoredRecord,
    signal: TerminalSignal,
    wait?: WaitForFinishResult,
    terminalEvent?: string,
  ): PaseoSubagentResult {
    const signalToken = signal.id ?? signal.turnId ?? signal.timestamp ?? "terminal";
    const deliveryId = record.deliveryId
      ?? (record.deliveryNamespace
        ? `${record.deliveryNamespace}:${signalToken}`
        : `paseo:${record.agentId}:${signalToken}`);
    const ping = signal.kind === "ping"
      ? { name: signal.name ?? record.name, message: signal.message ?? "The Paseo child requested help." }
      : undefined;
    const failure = signal.kind === "error" || signal.kind === "failed";
    const sessionResult = sessionSummary([record.sessionFile, record.initialSessionFile]);
    const waitResult = wait ? summaryFromWait(wait) : undefined;
    const summary = ping?.message ?? (failure
      ? `Paseo subagent failed: ${signal.errorMessage ?? signal.message ?? waitResultError(wait ?? { status: "error", final: null, error: null, lastMessage: null }) ?? "provider error"}`
      : sessionResult ?? waitResult ?? "Paseo subagent completed.");
    return {
      name: record.name,
      task: record.task,
      summary,
      sessionFile: record.sessionFile,
      exitCode: failure ? 1 : 0,
      elapsed: Math.max(0, Math.floor((Date.now() - record.startTime) / 1000)),
      deliveryId,
      ...(ping ? { ping } : {}),
      ...(failure ? { errorMessage: signal.errorMessage ?? signal.message ?? "Paseo provider error" } : {}),
      ...(terminalEvent ? { terminalEvent } : {}),
    };
  }

  private resultForWait(record: StoredRecord, wait: WaitForFinishResult, signal: TerminalSignal | null): PaseoSubagentResult {
    if (signal && terminalSignal(signal)) return this.resultForSignal(record, signal, wait);
    const event = wait.status === "error" ? "turn_failed" : wait.status === "permission" ? "permission_requested" : "turn_completed";
    const error = waitResultError(wait);
    const waitToken = wait.final?.activeTurn?.turnId ?? wait.final?.updatedAt ?? event;
    const deliveryId = record.deliveryId
      ?? (record.deliveryNamespace
        ? `${record.deliveryNamespace}:${waitToken}`
        : `paseo:${record.agentId}:${waitToken}`);
    return {
      name: record.name,
      task: record.task,
      summary: wait.status === "error"
        ? `Paseo subagent failed: ${error ?? "provider error"}`
        : sessionSummary([record.sessionFile, record.initialSessionFile])
          ?? summaryFromWait(wait)
          ?? "Paseo subagent completed without a final message.",
      sessionFile: record.sessionFile,
      exitCode: wait.status === "error" || wait.status === "permission" ? 1 : 0,
      elapsed: Math.max(0, Math.floor((Date.now() - record.startTime) / 1000)),
      deliveryId,
      ...(error ? { errorMessage: error } : {}),
      // An idle wait result does not identify why the turn became idle.  Only
      // expose an event when the SDK itself distinguished an error; callers
      // must use the child-side durable signal for done/help/cancel semantics.
      ...(wait.status === "error" ? { terminalEvent: "turn_failed" } : {}),
    };
  }

  private async waitForFinishCancellable(
    agentId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WaitForFinishResult> {
    const signals = [signal, this.closeController.signal].filter(
      (value): value is AbortSignal => !!value,
    );
    if (signals.some((value) => value.aborted)) throw new Error("Paseo watcher aborted");
    const wait = this.daemon.waitForFinish(agentId, timeoutMs);
    if (!signals.length) return wait;
    const abortHandlers: Array<() => void> = [];
    const aborted = new Promise<never>((_, reject) => {
      for (const observed of signals) {
        const abort = () => reject(new Error("Paseo watcher aborted"));
        abortHandlers.push(abort);
        observed.addEventListener("abort", abort, { once: true });
      }
    });
    try {
      return await Promise.race([wait, aborted]);
    } finally {
      for (let index = 0; index < signals.length; index += 1) {
        signals[index].removeEventListener("abort", abortHandlers[index]);
      }
      // The bounded daemon request will clean itself up. Never cancel the
      // managed child merely because this observer was closed.
      void wait.catch(() => undefined);
    }
  }

  async watch(recordInput: PaseoSubagentRecord, signal?: AbortSignal): Promise<PaseoSubagentResult> {
    const stored = this.store.records[recordInput.id] ?? ({
      ...recordInput,
      state: "running",
      createdAt: recordInput.startTime,
    } as StoredRecord);
    if (stored.state === "acked" && stored.result) return stored.result;
    if (stored.state === "completed" && stored.result) return stored.result;
    this.store.records[stored.id] = stored;
    while (true) {
      if (this.closed || signal?.aborted) throw new Error("Paseo watcher aborted");
      const durable = this.readSignal(stored);
      if (durable && terminalSignal(durable)) {
        // The child-side signal identifies done/help/error; the SDK wait below
        // confirms a genuine Paseo turn terminal event (including ctx.abort()).
        try {
          await this.ensureConnected();
          const wait = await this.waitForFinishCancellable(stored.agentId, 5_000, signal);
          if (wait.status === "idle" || wait.status === "error" || wait.status === "permission") {
            const result = this.resultForSignal(stored, durable, wait);
            stored.state = "completed";
            stored.result = result;
            stored.deliveryId = result.deliveryId;
            stored.completionSignalId = durable.id;
            stored.completionSignalAt = durable.timestamp;
            persistStore(this.options, this.store);
            return result;
          }
        } catch {
          // Reconnect below. The durable signal remains available.
        }
      }
      try {
        await this.ensureConnected();
        const wait = await this.waitForFinishCancellable(stored.agentId, 5_000, signal);
        if (wait.status === "timeout") continue;
        const signalNow = this.readSignal(stored);
        if (wait.status === "permission") {
          // Permission is a blocked state. Leave the agent resident until the
          // parent resolves it or explicitly resumes/interrupts it.
          await sleepWithSignal(WAIT_RETRY_MS, signal);
          continue;
        }
        if (wait.status === "idle" && !signalNow) {
          // waitForFinish is backed by turn terminal events, but an already
          // idle child with no event can be a pre-task snapshot. Keep waiting;
          // this avoids turning an interrupt into a synthetic completion.
          await sleepWithSignal(WAIT_RETRY_MS, signal);
          continue;
        }
        const result = this.resultForWait(stored, wait, signalNow);
        stored.state = "completed";
        stored.result = result;
        stored.deliveryId = result.deliveryId;
        persistStore(this.options, this.store);
        return result;
      } catch (error) {
        if (this.closed || signal?.aborted) throw new Error("Paseo watcher aborted");
        const message = error instanceof Error ? error.message : String(error);
        if (/provider error|turn failed/i.test(message) && !/transport|connect|socket|closed/i.test(message)) {
          const result: PaseoSubagentResult = {
            name: stored.name,
            task: stored.task,
            summary: `Paseo subagent failed: ${message}`,
            sessionFile: stored.sessionFile,
            exitCode: 1,
            elapsed: Math.max(0, Math.floor((Date.now() - stored.startTime) / 1000)),
            deliveryId: stored.deliveryId ?? `paseo:${stored.agentId}:error`,
            errorMessage: message,
            terminalEvent: "turn_failed",
          };
          stored.state = "completed";
          stored.result = result;
          stored.deliveryId = result.deliveryId;
          persistStore(this.options, this.store);
          return result;
        }
        // Daemon disconnects are expected. The child remains resident and the
        // retry uses the SDK's reconnect path; no cancel/delete is performed.
        await sleepWithSignal(WAIT_RETRY_MS, signal);
      }
    }
  }

  async resume(input: PaseoResumeInput): Promise<PaseoSubagentRecord> {
    const candidates = input.agentId
      ? Object.values(this.store.records).filter((record) => record.agentId === input.agentId)
      : input.sessionPath
        ? Object.values(this.store.records).filter((record) => record.sessionFile === input.sessionPath || record.initialSessionFile === input.sessionPath)
        : [];
    const source = candidates.sort((left, right) => right.startTime - left.startTime)[0];
    // A session path or agent ID is only resumable when this parent recorded
    // the original delegation. Importing an arbitrary Pi session here would
    // lose callerAgentId lineage and allow an inherited environment variable
    // to impersonate another parent.
    if (!source) throw new Error("Paseo resume requires a known agentId or sessionPath recorded by this parent");
    await this.ensureConnected();
    const snapshot = await this.refreshSnapshot(source.agentId);
    if (snapshot && !isProviderPi(snapshot)) throw new Error(`Paseo resume supports Pi agents only; received '${snapshot.provider}'.`);
    if (snapshot?.status === "closed" || snapshot?.archivedAt) {
      throw new Error(
        `Paseo agent ${snapshot.id} is archived/closed. Reopen it in Paseo before resuming so parentage is preserved.`,
      );
    }
    // Recompute from the current native session's header on every resume.
    // Company scope from the persisted record/parent is a lower bound, so
    // leaving a company checkout cannot silently downgrade this child.
    const currentSessionFile = nativeSessionFile(snapshot) ?? source.sessionFile;
    const accountContext = this.accountContextFor(source.cwd, source, input, currentSessionFile);
    const sourceRecord = source;
    // This guard runs before any bootstrap or task message. Paseo cannot
    // switch a live Pi runtime's loaded credential store in place.
    this.assertAccountCompatibility(sourceRecord, snapshot, accountContext, "resume");
    await this.prepareAccountProfile(accountContext);
    const recordId = `resume-${randomUUID()}`;
    const deliveryNamespace = `paseo:${sourceRecord.agentId}:${recordId}`;
    const signalFile = sourceRecord.signalFile ?? `${sourceRecord.sessionFile}.paseo-events.jsonl`;
    const previousLegacyMtime = fileModificationTime(`${sourceRecord.sessionFile}.exit`);
    clearLegacyExitSignal(sourceRecord.sessionFile);
    const autoExit = input.autoExit ?? true;
    const record: StoredRecord = {
      ...sourceRecord,
      id: recordId,
      name: input.name ?? sourceRecord.name,
      task: input.message ?? "resumed session",
      startTime: Date.now(),
      autoExit,
      interactive: !autoExit,
      state: "running",
      createdAt: Date.now(),
      result: undefined,
      deliveryId: undefined,
      deliveryNamespace,
      completionSignalId: undefined,
      completionSignalAt: undefined,
      pendingSignal: undefined,
      signalFile,
      signalOffset: fileSize(signalFile),
      signalBaselineAt: Date.now(),
      legacySignalMtime: previousLegacyMtime,
      taskSentAt: undefined,
      bootstrapSentAt: undefined,
      accountScope: accountContext?.selection.scope ?? sourceRecord.accountScope,
      accountPolicyFile: accountContext?.selection.policyFile ?? sourceRecord.accountPolicyFile,
      credentialDir: accountContext?.selection.credentialDir ?? sourceRecord.credentialDir,
      provider: accountContext?.selection.provider ?? sourceRecord.provider ?? snapshot?.provider ?? "pi",
    };
    if (source && source.id !== record.id && source.state === "running") {
      // A follow-up owns the same Paseo child. Do not let a stale watcher for
      // the previous turn reappear after a parent reload.
      source.state = "acked";
      source.supersededAt = Date.now();
    }
    this.store.records[record.id] = record;
    persistStore(this.options, this.store);

    const bootstrap: PaseoBootstrapInput = { ...(sourceRecord.bootstrap ?? {}) };
    const actual = nativeSessionFile(snapshot) ?? record.sessionFile;
    await this.sendBootstrap(record, input, bootstrap, actual);
    if (input.message) {
      record.taskSentAt = Date.now();
      await this.daemon.sendAgentMessage(record.agentId, input.message, {
        messageId: `paseo-resume-${record.agentId}-${record.id}`,
      });
      persistStore(this.options, this.store);
    }
    return { ...record };
  }

  async restore(): Promise<PaseoSubagentRecord[]> {
    await this.ensureConnected();
    const pending: PaseoSubagentRecord[] = [];
    for (const record of Object.values(this.store.records)) {
      if (record.state === "acked") continue;
      const snapshot = await this.refreshSnapshot(record.agentId);
      if (snapshot && !isProviderPi(snapshot)) continue;
      if (snapshot) {
        record.workspaceId = snapshot.workspaceId ?? record.workspaceId;
        const native = nativeSessionFile(snapshot);
        if (native && !record.bootstrap?.sessionFile) record.sessionFile = native;
      }
      pending.push({ ...record });
    }
    persistStore(this.options, this.store);
    return pending;
  }

  async interrupt(agentId: string): Promise<void> {
    await this.ensureConnected();
    await this.daemon.cancelAgent(agentId);
  }

  async ack(recordInput: PaseoSubagentRecord, result?: PaseoSubagentResult): Promise<string> {
    const record = this.store.records[recordInput.id] ?? (recordInput as StoredRecord);
    const deliveryId = result?.deliveryId ?? record.deliveryId ?? `paseo:${record.agentId}:terminal`;
    record.deliveryId = deliveryId;
    record.state = "acked";
    record.result = result ?? record.result;
    this.store.records[record.id] = record;
    persistStore(this.options, this.store);
    return deliveryId;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort();
    // Closing this client only releases the observer connection. Paseo owns
    // every child process, so a parent disconnect/reload never kills children.
    await this.daemon.close().catch(() => undefined);
  }
}

export default PaseoBackend;
