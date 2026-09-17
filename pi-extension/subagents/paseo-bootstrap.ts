/**
 * Runtime bootstrap for Pi processes managed by Paseo.
 *
 * Paseo starts a Pi RPC process with an empty session, then sends the internal
 * `/pi-subagent-bootstrap` command. A full-context child has already been
 * seeded into a separate JSONL file by the caller. The command switches to
 * that file and the newly rebound extension runtime applies the child role,
 * tool restrictions, and session metadata.
 *
 * The process environment is the hand-off boundary. It survives Pi's
 * `switchSession()` replacement, while an ExtensionAPI object from before the
 * replacement becomes stale. This module intentionally uses only public Pi
 * APIs (`switchSession`, `setActiveTools`, `setModel`, `setThinkingLevel`, and
 * `getCommands`).
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalPath } from "./account-scope.mjs";

export const PASEO_BOOTSTRAP_COMMAND = "pi-subagent-bootstrap";
export const PASEO_BOOTSTRAP_ENV = "PI_SUBAGENT_BOOTSTRAP";
export const PASEO_BOOTSTRAP_READY_ENV = "PI_SUBAGENT_BOOTSTRAP_READY";
export const PASEO_BOOTSTRAP_VERSION = 1 as const;

export type PaseoBootstrapSystemPromptMode = "append" | "replace";

export interface PaseoBootstrapModel {
  provider: string;
  id: string;
}

/**
 * Flat wire shape used by the Pi extension and Paseo SDK.
 *
 * The decoder also accepts the older nested `{ restrictions, identity,
 * activity, session }` spelling. Keeping the wire shape flat makes the
 * payload easy to inspect and keeps it forward-compatible with SDK callers.
 */
export interface PaseoBootstrapConfig {
  version: typeof PASEO_BOOTSTRAP_VERSION;
  requestId?: string;
  sessionFile?: string;
  tools?: string[];
  deniedTools?: string[];
  systemPrompt?: string;
  systemPromptMode?: PaseoBootstrapSystemPromptMode;
  skills?: string[];
  name?: string;
  agent?: string;
  childId?: string;
  activityFile?: string;
  autoExit?: boolean;
  interactive?: boolean;
  model?: PaseoBootstrapModel;
  thinkingLevel?: string;
  accountScope?: "personal" | "company";
  accountPolicyFile?: string;
  credentialDir?: string;
  providerScope?: "personal" | "company";
  parentAgentId?: string;
  parentSessionId?: string;
  paseoAgentId?: string;
}

export interface PaseoBootstrapApplyResult {
  applied: boolean;
  sessionSwitched: boolean;
  cancelled?: boolean;
}

interface RecordLike {
  [key: string]: unknown;
}

interface BootstrapCommandContext {
  mode?: string;
  cwd?: string;
  sessionManager?: {
    getSessionFile?: () => string | null;
  };
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
  modelRegistry?: {
    find?: (provider: string, modelId: string) => unknown;
  };
  switchSession?: (
    sessionPath: string,
    options?: { withSession?: (ctx: BootstrapCommandContext) => Promise<void> },
  ) => Promise<{ cancelled?: boolean } | void>;
  ui?: { notify?: (message: string, type?: string) => void };
}

interface BootstrapExtensionAPI {
  on: ExtensionAPI["on"];
  registerCommand: ExtensionAPI["registerCommand"];
  getCommands?: ExtensionAPI["getCommands"];
  getAllTools?: ExtensionAPI["getAllTools"];
  getActiveTools?: ExtensionAPI["getActiveTools"];
  setActiveTools?: ExtensionAPI["setActiveTools"];
  setModel?: ExtensionAPI["setModel"];
  getThinkingLevel?: ExtensionAPI["getThinkingLevel"];
  setThinkingLevel?: ExtensionAPI["setThinkingLevel"];
  setSessionName?: ExtensionAPI["setSessionName"];
}

function isRecord(value: unknown): value is RecordLike {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object: RecordLike, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readStringPreservingEmpty(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readModel(value: unknown): PaseoBootstrapModel | undefined {
  if (typeof value === "string") {
    const separator = value.indexOf("/");
    if (separator > 0 && separator < value.length - 1) {
      return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
    }
    const colon = value.indexOf(":");
    if (colon > 0 && colon < value.length - 1) {
      return { provider: value.slice(0, colon), id: value.slice(colon + 1) };
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const provider = readString(value.provider);
  const id = readString(value.id) ?? readString(value.modelId);
  return provider && id ? { provider, id } : undefined;
}

function readPath(
  root: RecordLike,
  nested: RecordLike | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const fromRoot = readString(root[key]);
    if (fromRoot) return fromRoot;
    const fromNested = nested ? readString(nested[key]) : undefined;
    if (fromNested) return fromNested;
  }
  return undefined;
}

function normalizeSkillName(value: string): string {
  return value.trim().replace(/^\/?skill:/, "");
}

/** Normalize and validate a decoded bootstrap payload. */
export function normalizePaseoBootstrap(value: unknown): PaseoBootstrapConfig {
  if (!isRecord(value)) {
    throw new Error("Paseo Pi bootstrap payload must be a JSON object");
  }

  const rawVersion = value.version;
  if (rawVersion !== undefined && rawVersion !== PASEO_BOOTSTRAP_VERSION) {
    throw new Error(`Unsupported Paseo Pi bootstrap version: ${String(rawVersion)}`);
  }

  const restrictions = isRecord(value.restrictions) ? value.restrictions : undefined;
  const identity = isRecord(value.identity) ? value.identity : undefined;
  const activity = isRecord(value.activity) ? value.activity : undefined;
  const session = isRecord(value.session) ? value.session : undefined;

  const result: PaseoBootstrapConfig = { version: PASEO_BOOTSTRAP_VERSION };
  const requestId = readPath(value, undefined, "requestId", "bootstrapRequestId");
  if (requestId) result.requestId = requestId;
  for (const key of ["accountScope", "providerScope"] as const) {
    if (value[key] !== undefined) {
      if (value[key] !== "personal" && value[key] !== "company") {
        throw new Error(`Invalid Paseo account scope: ${key}`);
      }
      result[key] = value[key];
    }
  }
  for (const key of ["accountPolicyFile", "credentialDir", "parentAgentId", "parentSessionId", "paseoAgentId"] as const) {
    if (value[key] !== undefined) {
      const path = readString(value[key]);
      if (!path) throw new Error(`Paseo account bootstrap requires ${key}`);
      result[key] = path;
    }
  }
  const sessionFile = readPath(value, session, "sessionFile", "sessionPath", "path");
  if (sessionFile) result.sessionFile = sessionFile;

  const tools = readStringArray(
    hasOwn(value, "tools") ? value.tools : restrictions?.tools,
  );
  if (tools !== undefined) result.tools = tools;
  const deniedTools = readStringArray(
    hasOwn(value, "deniedTools")
      ? value.deniedTools
      : restrictions?.deniedTools ?? restrictions?.denyTools,
  );
  if (deniedTools !== undefined) result.deniedTools = deniedTools;

  const systemPrompt = readStringPreservingEmpty(
    hasOwn(value, "systemPrompt") ? value.systemPrompt : identity?.systemPrompt,
  );
  if (systemPrompt !== undefined) result.systemPrompt = systemPrompt;
  const systemPromptMode = readString(
    hasOwn(value, "systemPromptMode") ? value.systemPromptMode : identity?.systemPromptMode,
  );
  if (systemPromptMode === "append" || systemPromptMode === "replace") {
    result.systemPromptMode = systemPromptMode;
  } else if (systemPromptMode !== undefined) {
    throw new Error(`Invalid Paseo Pi systemPromptMode: ${systemPromptMode}`);
  }

  const skillsValue = hasOwn(value, "skills") ? value.skills : restrictions?.skills;
  const skills = readStringArray(skillsValue)?.map(normalizeSkillName).filter(Boolean);
  if (skills !== undefined) result.skills = skills;

  const name = readPath(value, identity, "name");
  if (name) result.name = name;
  const agent = readPath(value, identity, "agent");
  if (agent) result.agent = agent;
  const childId = readPath(value, activity, "childId", "id", "runningChildId");
  if (childId) result.childId = childId;
  const activityFile = readPath(value, activity, "activityFile", "file");
  if (activityFile) result.activityFile = activityFile;

  const autoExit = readBoolean(hasOwn(value, "autoExit") ? value.autoExit : restrictions?.autoExit);
  if (autoExit !== undefined) result.autoExit = autoExit;
  const interactive = readBoolean(
    hasOwn(value, "interactive") ? value.interactive : restrictions?.interactive,
  );
  if (interactive !== undefined) result.interactive = interactive;

  const model = readModel(hasOwn(value, "model") ? value.model : undefined);
  if (model) result.model = model;
  const thinkingLevel = readPath(value, undefined, "thinkingLevel", "thinking");
  if (thinkingLevel) result.thinkingLevel = thinkingLevel;

  return result;
}

/** Encode the wire payload for `PI_SUBAGENT_BOOTSTRAP` or command arguments. */
export function encodePaseoBootstrap(config: PaseoBootstrapConfig): string {
  return Buffer.from(JSON.stringify(normalizePaseoBootstrap(config)), "utf8").toString("base64url");
}

/** Decode either base64url JSON (the wire format) or raw JSON (useful in tests). */
export function decodePaseoBootstrap(rawValue: string): PaseoBootstrapConfig {
  const raw = rawValue.trim();
  if (!raw) throw new Error("Paseo Pi bootstrap payload is empty");

  const parse = (text: string): PaseoBootstrapConfig => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error("Invalid Paseo Pi bootstrap JSON", { cause: error });
    }
    return normalizePaseoBootstrap(value);
  };

  if (raw.startsWith("{")) return parse(raw);
  try {
    return parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch (encodedError) {
    // Accept a standard base64 payload too; this costs nothing and makes the
    // command easy to invoke from SDKs that do not expose base64url helpers.
    try {
      return parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
      throw encodedError;
    }
  }
}

function envStringArray(name: string): string[] | undefined {
  const value = process.env[name];
  return value == null ? undefined : readStringArray(value);
}

function modelFromEnvironment(): PaseoBootstrapModel | undefined {
  const provider = readString(process.env.PI_SUBAGENT_MODEL_PROVIDER);
  const id = readString(process.env.PI_SUBAGENT_MODEL_ID);
  if (provider && id) return { provider, id };
  return readModel(process.env.PI_SUBAGENT_MODEL);
}

function mergeBootstrapConfigs(
  base: PaseoBootstrapConfig | null,
  override: PaseoBootstrapConfig | null,
): PaseoBootstrapConfig | null {
  if (!base && !override) return null;
  const merged: PaseoBootstrapConfig = {
    version: PASEO_BOOTSTRAP_VERSION,
    ...(base ?? {}),
    ...(override ?? {}),
  };
  // Model and thinking are session state when the SDK does not explicitly
  // override them. In particular, a fork's seeded session contains the
  // parent's model/thinking settings; stale values inherited from the empty
  // launcher process must not win after switchSession(). Keep environment
  // fallbacks for the initial unbootstrapped runtime, but discard them as
  // soon as a command payload is present without an explicit override.
  if (override) {
    if (override.model === undefined) delete merged.model;
    if (override.thinkingLevel === undefined) delete merged.thinkingLevel;
  }
  return merged;
}

function readBootstrapFromEnvironment(): PaseoBootstrapConfig | null {
  let encoded: PaseoBootstrapConfig | null = null;
  const raw = process.env[PASEO_BOOTSTRAP_ENV];
  if (raw) {
    try {
      encoded = decodePaseoBootstrap(raw);
    } catch (error) {
      throw new Error(
        `Invalid Paseo Pi bootstrap environment: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const fallback: PaseoBootstrapConfig = { version: PASEO_BOOTSTRAP_VERSION };
  const requestId = readString(process.env.PI_SUBAGENT_BOOTSTRAP_REQUEST_ID);
  if (requestId) fallback.requestId = requestId;
  const sessionFile = readString(process.env.PI_SUBAGENT_SESSION);
  if (sessionFile) fallback.sessionFile = sessionFile;
  const tools = envStringArray("PI_SUBAGENT_TOOLS");
  if (tools !== undefined) fallback.tools = tools;
  const deniedTools = envStringArray("PI_DENY_TOOLS");
  if (deniedTools !== undefined) fallback.deniedTools = deniedTools;
  const systemPrompt = process.env.PI_SUBAGENT_SYSTEM_PROMPT;
  if (systemPrompt !== undefined) fallback.systemPrompt = systemPrompt;
  const systemPromptMode = readString(process.env.PI_SUBAGENT_SYSTEM_PROMPT_MODE);
  if (systemPromptMode === "append" || systemPromptMode === "replace") {
    fallback.systemPromptMode = systemPromptMode;
  }
  const skills = envStringArray("PI_SUBAGENT_SKILLS");
  if (skills !== undefined) fallback.skills = skills.map(normalizeSkillName).filter(Boolean);
  const name = readString(process.env.PI_SUBAGENT_NAME);
  if (name) fallback.name = name;
  const agent = readString(process.env.PI_SUBAGENT_AGENT);
  if (agent) fallback.agent = agent;
  const childId = readString(process.env.PI_SUBAGENT_ID);
  if (childId) fallback.childId = childId;
  const activityFile = readString(process.env.PI_SUBAGENT_ACTIVITY_FILE);
  if (activityFile) fallback.activityFile = activityFile;
  if (process.env.PI_SUBAGENT_AUTO_EXIT !== undefined) {
    fallback.autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  }
  if (process.env.PI_SUBAGENT_INTERACTIVE !== undefined) {
    fallback.interactive = process.env.PI_SUBAGENT_INTERACTIVE === "1";
  }
  const model = modelFromEnvironment();
  if (model) fallback.model = model;
  const thinkingLevel = readString(process.env.PI_SUBAGENT_THINKING);
  if (thinkingLevel) fallback.thinkingLevel = thinkingLevel;

  const hasFallback = Object.keys(fallback).length > 1;
  return mergeBootstrapConfigs(hasFallback ? fallback : null, encoded);
}

function bootstrapFailureConfig(): PaseoBootstrapConfig {
  const config: PaseoBootstrapConfig = { version: PASEO_BOOTSTRAP_VERSION };
  const requestId = readString(process.env.PI_SUBAGENT_BOOTSTRAP_REQUEST_ID);
  const sessionFile = readString(process.env.PI_SUBAGENT_SESSION);
  if (requestId) config.requestId = requestId;
  if (sessionFile) config.sessionFile = sessionFile;
  return config;
}

function writeBootstrapEnvironment(config: PaseoBootstrapConfig): void {
  const normalized = normalizePaseoBootstrap(config);
  process.env[PASEO_BOOTSTRAP_ENV] = encodePaseoBootstrap(normalized);

  const assign = (name: string, value: string | undefined): void => {
    if (value === undefined) return;
    process.env[name] = value;
  };
  assign("PI_SUBAGENT_BOOTSTRAP_REQUEST_ID", normalized.requestId);
  assign("PI_SUBAGENT_SESSION", normalized.sessionFile);
  assign("PI_SUBAGENT_NAME", normalized.name);
  assign("PI_SUBAGENT_AGENT", normalized.agent);
  assign("PI_SUBAGENT_ID", normalized.childId);
  assign("PI_SUBAGENT_ACTIVITY_FILE", normalized.activityFile);
  if (normalized.tools !== undefined) assign("PI_SUBAGENT_TOOLS", normalized.tools.join(","));
  if (normalized.deniedTools !== undefined) process.env.PI_DENY_TOOLS = normalized.deniedTools.join(",");
  if (normalized.systemPrompt !== undefined) process.env.PI_SUBAGENT_SYSTEM_PROMPT = normalized.systemPrompt;
  if (normalized.systemPromptMode !== undefined) {
    process.env.PI_SUBAGENT_SYSTEM_PROMPT_MODE = normalized.systemPromptMode;
  }
  if (normalized.skills !== undefined) process.env.PI_SUBAGENT_SKILLS = normalized.skills.join(",");
  if (normalized.autoExit !== undefined) process.env.PI_SUBAGENT_AUTO_EXIT = normalized.autoExit ? "1" : "0";
  if (normalized.interactive !== undefined) {
    process.env.PI_SUBAGENT_INTERACTIVE = normalized.interactive ? "1" : "0";
  }
  if (normalized.model) {
    process.env.PI_SUBAGENT_MODEL = `${normalized.model.provider}/${normalized.model.id}`;
    process.env.PI_SUBAGENT_MODEL_PROVIDER = normalized.model.provider;
    process.env.PI_SUBAGENT_MODEL_ID = normalized.model.id;
  }
  assign("PI_SUBAGENT_THINKING", normalized.thinkingLevel);
}

export interface PaseoBootstrapReady {
  version: typeof PASEO_BOOTSTRAP_VERSION;
  ok: boolean;
  requestId: string;
  sessionFile: string | null;
  appliedAt: string;
  tools?: string[];
  deniedTools?: string[];
  skills?: string[];
  systemPromptMode?: PaseoBootstrapSystemPromptMode;
  name?: string;
  agent?: string;
  childId?: string;
  model?: PaseoBootstrapModel;
  thinkingLevel?: string;
  autoExit?: boolean;
  interactive?: boolean;
  error?: string;
}

function currentSessionFile(ctx: BootstrapCommandContext): string | null {
  return ctx.sessionManager?.getSessionFile?.() ?? null;
}

function sameSessionFile(left: string | undefined, right: string | null): boolean {
  if (!left) return true;
  if (!right) return false;
  try {
    return resolve(left) === resolve(right);
  } catch {
    return left === right;
  }
}

function bootstrapReadyPath(): string | undefined {
  const value = process.env[PASEO_BOOTSTRAP_READY_ENV]?.trim();
  return value || undefined;
}

/**
 * Publish a small atomic handshake for SDK callers. The path is supplied by
 * the SDK through `PI_SUBAGENT_BOOTSTRAP_READY`; the JSON is written only
 * after the target session's fresh `session_start` hook has applied all
 * settings. A failed validation is written as `{ok:false,error}` so callers
 * do not have to wait for a timeout to learn that bootstrap was rejected.
 * The SDK should remove or replace the file before issuing a new bootstrap
 * request and include a unique `requestId` in that request.
 */
function writeBootstrapReady(
  config: PaseoBootstrapConfig,
  ctx: BootstrapCommandContext,
  error?: unknown,
): void {
  const outputPath = bootstrapReadyPath();
  if (!outputPath) return;
  const sessionFile = currentSessionFile(ctx);
  const ready: PaseoBootstrapReady = {
    version: PASEO_BOOTSTRAP_VERSION,
    ok: !error,
    requestId: config.requestId ?? process.env.PI_SUBAGENT_BOOTSTRAP_REQUEST_ID ?? randomUUID(),
    sessionFile: config.sessionFile ?? sessionFile ?? null,
    appliedAt: new Date().toISOString(),
    ...(config.tools !== undefined ? { tools: config.tools } : {}),
    ...(config.deniedTools !== undefined ? { deniedTools: config.deniedTools } : {}),
    ...(config.skills !== undefined ? { skills: config.skills } : {}),
    ...(config.systemPromptMode !== undefined ? { systemPromptMode: config.systemPromptMode } : {}),
    ...(config.name !== undefined ? { name: config.name } : {}),
    ...(config.agent !== undefined ? { agent: config.agent } : {}),
    ...(config.childId !== undefined ? { childId: config.childId } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.thinkingLevel !== undefined ? { thinkingLevel: config.thinkingLevel } : {}),
    ...(config.autoExit !== undefined ? { autoExit: config.autoExit } : {}),
    ...(config.interactive !== undefined ? { interactive: config.interactive } : {}),
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  };
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(ready)}\n`, "utf8");
    renameSync(temporaryPath, outputPath);
  } catch {
    try {
      // Keep the handshake best effort. A caller can still observe a Pi RPC
      // command error, while this fallback helps on filesystems without an
      // atomic rename across the chosen temporary path.
      writeFileSync(outputPath, `${JSON.stringify(ready)}\n`, "utf8");
    } catch {
      // No readiness channel is available; the SDK will surface its timeout.
    }
  }
}

function publishBootstrapReadyIfTargetMatches(
  config: PaseoBootstrapConfig,
  ctx: BootstrapCommandContext,
): void {
  if (!sameSessionFile(config.sessionFile, currentSessionFile(ctx))) return;
  writeBootstrapReady(config, ctx);
}

function parseModelReference(model: PaseoBootstrapModel | undefined): PaseoBootstrapModel | undefined {
  if (!model) return undefined;
  return model.provider && model.id ? model : undefined;
}

async function applyModelAndThinking(
  pi: BootstrapExtensionAPI,
  ctx: BootstrapCommandContext,
  config: PaseoBootstrapConfig,
): Promise<void> {
  const model = parseModelReference(config.model);
  if (model) {
    if (!pi.setModel || !ctx.modelRegistry?.find) {
      throw new Error("This Pi runtime cannot apply the requested Paseo child model");
    }
    const registryModel = ctx.modelRegistry.find(model.provider, model.id);
    if (registryModel === undefined) {
      throw new Error(`Unsupported Paseo Pi model: ${model.provider}/${model.id}`);
    }
    const applied = await pi.setModel(registryModel as never);
    if (applied === false) {
      throw new Error(`Paseo Pi could not activate model: ${model.provider}/${model.id}`);
    }
  }
  if (config.thinkingLevel && pi.setThinkingLevel) {
    pi.setThinkingLevel(config.thinkingLevel as never);
  }
}

function applyActiveTools(pi: BootstrapExtensionAPI, config: PaseoBootstrapConfig): void {
  const denied = new Set(config.deniedTools ?? []);
  if (config.tools === undefined && denied.size === 0) return;
  if (!pi.setActiveTools) {
    throw new Error("This Pi runtime cannot apply Paseo child tool restrictions");
  }

  const allTools = pi.getAllTools?.();
  if (!allTools) {
    throw new Error("This Pi runtime cannot validate Paseo child tool restrictions");
  }
  const available = new Set(allTools.map((tool) => tool.name));

  if (config.tools !== undefined) {
    const unsupported = config.tools.filter((tool) => !available.has(tool));
    if (unsupported.length > 0) {
      throw new Error(`Unsupported Paseo Pi tool(s): ${unsupported.join(", ")}`);
    }
    // Empty explicit lists are meaningful: they disable every tool, including
    // control tools. The caller adds caller_ping/subagent_done when needed.
    pi.setActiveTools(config.tools.filter((tool) => !denied.has(tool)));
    return;
  }

  const current = pi.getActiveTools?.();
  if (!current) {
    throw new Error("This Pi runtime cannot preserve active tools while applying Paseo denials");
  }
  pi.setActiveTools(current.filter((tool) => !denied.has(tool)));
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function readConfiguredSkillBlocks(pi: BootstrapExtensionAPI, skills: string[]): string[] {
  if (!pi.getCommands) {
    throw new Error("This Pi runtime cannot resolve requested Paseo child skills");
  }
  const commands = pi.getCommands() as Array<{
    name?: string;
    source?: string;
    sourceInfo?: { path?: string; baseDir?: string };
  }>;
  const blocks: string[] = [];
  for (const name of skills) {
    const command = commands.find(
      (candidate) =>
        candidate.source === "skill" &&
        (candidate.name === `skill:${name}` || candidate.name === `/skill:${name}`),
    );
    const path = command?.sourceInfo?.path;
    if (!command || !path || !existsSync(path)) {
      throw new Error(`Unsupported Paseo Pi skill: ${name}`);
    }
    try {
      const body = stripFrontmatter(readFileSync(path, "utf8"));
      if (!body) throw new Error("skill file is empty");
      const baseDir = command?.sourceInfo?.baseDir ?? dirname(path);
      blocks.push(
        `<skill name="${escapeXml(name)}" location="${escapeXml(path)}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`,
      );
    } catch (error) {
      throw new Error(
        `Could not load Paseo Pi skill "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return blocks;
}

function buildBootstrapSystemPrompt(
  pi: BootstrapExtensionAPI,
  baseSystemPrompt: string,
  config: PaseoBootstrapConfig,
): string | undefined {
  let systemPrompt = baseSystemPrompt;
  if (config.systemPromptMode && config.systemPrompt !== undefined) {
    systemPrompt =
      config.systemPromptMode === "replace"
        ? config.systemPrompt
        : `${baseSystemPrompt}${baseSystemPrompt && config.systemPrompt ? "\n\n" : ""}${config.systemPrompt}`;
  }
  const skillBlocks = config.skills?.length ? readConfiguredSkillBlocks(pi, config.skills) : [];
  if (skillBlocks.length > 0) {
    systemPrompt = `${systemPrompt}${systemPrompt ? "\n\n" : ""}${skillBlocks.join("\n\n")}`;
  }
  return systemPrompt === baseSystemPrompt ? undefined : systemPrompt;
}

/** Apply child settings to the currently bound Pi runtime. */
export async function applyPaseoBootstrap(
  pi: BootstrapExtensionAPI,
  ctx: BootstrapCommandContext,
  config: PaseoBootstrapConfig,
): Promise<PaseoBootstrapApplyResult> {
  // Credential selection happened before this process was launched. Bootstrap
  // may verify that decision, but must never change a running process's auth
  // directory or promote a loaded personal runtime by changing environment.
  if (config.accountScope) {
    if (
      process.env.PI_ACCOUNT_LAUNCHER !== "1" ||
      process.env.PI_ACCOUNT_SCOPE !== config.accountScope ||
      !config.credentialDir || !process.env.PI_CODING_AGENT_DIR ||
      canonicalPath(config.credentialDir) !== canonicalPath(process.env.PI_CODING_AGENT_DIR) ||
      !config.accountPolicyFile || !process.env.PI_ACCOUNT_POLICY_FILE ||
      canonicalPath(config.accountPolicyFile) !== canonicalPath(process.env.PI_ACCOUNT_POLICY_FILE) ||
      (config.providerScope === "company" && config.accountScope !== "company")
    ) {
      throw new Error("Paseo account bootstrap does not match the preflighted runtime. Relaunch with the selected account profile.");
    }
  }
  // Resolve every requested skill while the target session's resource loader
  // is bound. Failing here prevents a readiness success from being published
  // for a child that would silently lose role instructions later.
  if (config.skills?.length) readConfiguredSkillBlocks(pi, config.skills);
  applyActiveTools(pi, config);
  await applyModelAndThinking(pi, ctx, config);
  if (config.name && pi.setSessionName) pi.setSessionName(config.name);
  return { applied: true, sessionSwitched: false };
}

/** Register the private command used by Paseo's Pi SDK adapter. */
export function registerPaseoBootstrap(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_BACKEND !== "paseo") return;

  const api = pi as unknown as BootstrapExtensionAPI;

  // The extension factory is invoked again after switchSession(). This hook
  // is therefore the safe place to apply settings using the fresh `pi` API.
  pi.on("session_start", async (_event, rawCtx) => {
    const ctx = rawCtx as unknown as BootstrapCommandContext;
    let config: PaseoBootstrapConfig | null;
    try {
      config = readBootstrapFromEnvironment();
    } catch (error) {
      writeBootstrapReady(bootstrapFailureConfig(), ctx, error);
      throw error;
    }
    if (!config) return;
    // The launcher initially opens an empty session before the command
    // switches to the seeded file. Do not publish readiness for that stale
    // runtime; the target session gets a fresh factory/session_start event.
    if (config.sessionFile && !sameSessionFile(config.sessionFile, currentSessionFile(ctx))) return;
    try {
      await applyPaseoBootstrap(api, ctx, config);
      publishBootstrapReadyIfTargetMatches(config, ctx);
    } catch (error) {
      writeBootstrapReady(config, ctx, error);
      throw error;
    }
  });

  pi.on("before_agent_start", (event) => {
    const config = readBootstrapFromEnvironment();
    if (!config) return;
    const systemPrompt = buildBootstrapSystemPrompt(
      api,
      (event as { systemPrompt: string }).systemPrompt,
      config,
    );
    return systemPrompt === undefined ? undefined : { systemPrompt };
  });

  pi.registerCommand(PASEO_BOOTSTRAP_COMMAND, {
    description: "Internal Paseo child runtime bootstrap",
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as unknown as BootstrapCommandContext;
      let parsed: PaseoBootstrapConfig;
      try {
        parsed = decodePaseoBootstrap(args.trim() || process.env[PASEO_BOOTSTRAP_ENV] || "");
      } catch (error) {
        writeBootstrapReady(bootstrapFailureConfig(), ctx, error);
        throw error;
      }
      let config: PaseoBootstrapConfig | null;
      try {
        config = mergeBootstrapConfigs(readBootstrapFromEnvironment(), parsed);
      } catch (error) {
        writeBootstrapReady(bootstrapFailureConfig(), ctx, error);
        throw error;
      }
      if (!config) throw new Error("Paseo Pi bootstrap payload is missing");
      writeBootstrapEnvironment(config);

      const targetSession = config.sessionFile;
      const currentSession = ctx.sessionManager?.getSessionFile?.() ?? null;
      const switchSession = ctx.switchSession;
      if (targetSession && !sameSessionFile(targetSession, currentSession)) {
        if (!switchSession) {
          const error = new Error("This Pi version does not support managed session switching");
          writeBootstrapReady(config, ctx, error);
          throw error;
        }
        let result: { cancelled?: boolean } | void;
        try {
          result = await switchSession(targetSession, {
            // The new factory's session_start hook applies the settings with
            // its fresh ExtensionAPI. Do not touch stale `pi` after await.
            withSession: async () => undefined,
          });
        } catch (error) {
          writeBootstrapReady(config, ctx, error);
          throw error;
        }
        if (result?.cancelled) {
          const error = new Error("Paseo Pi bootstrap session switch was cancelled");
          writeBootstrapReady(config, ctx, error);
          throw error;
        }
        return;
      }

      try {
        await applyPaseoBootstrap(api, ctx, config);
        publishBootstrapReadyIfTargetMatches(config, ctx);
      } catch (error) {
        writeBootstrapReady(config, ctx, error);
        throw error;
      }
    },
  });
}

export default registerPaseoBootstrap;
