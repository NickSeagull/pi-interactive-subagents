import { appendFileSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { canonicalPath } from "./account-scope.mjs";

/** Reject credential/config targets using metadata before any content read. */
export function validateAccountSessionFile(sessionFile, { requireHeader = false, allowMissing = true } = {}) {
  const path = canonicalPath(sessionFile);
  if (!path.endsWith(".jsonl")) throw new Error("Scoped sessions require a .jsonl Pi session file, never a credential or configuration file");
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Session target must be a private regular file, not a hard link");
  } catch (error) {
    if (error.code === "ENOENT" && allowMissing) return path;
    throw error;
  }
  if (requireHeader) {
    let header;
    try { header = JSON.parse(readFileSync(path, "utf8").split(/\r?\n/).find((line) => line.trim()) ?? ""); }
    catch { throw new Error("Existing session file is empty or malformed; refusing to modify it"); }
    if (header?.type !== "session" || ![1, 2, 3].includes(header.version) || typeof header.id !== "string" || typeof header.cwd !== "string" || !header.cwd) {
      throw new Error("Existing session file lacks a valid Pi session header; refusing to modify it");
    }
  }
  return path;
}

/**
 * The metadata entry is intentionally a Pi custom entry.  It contains only
 * account routing metadata; it never contains an auth token or any other
 * credential material.
 */
export const ACCOUNT_SESSION_CUSTOM_TYPE = "pi-account-scope";
export const ACCOUNT_SESSION_VERSION = 1;

const ACCOUNT_SCOPES = new Set(["personal", "company"]);

/**
 * @typedef {"personal" | "company"} AccountScope
 * @typedef {Object} AccountSessionMetadata
 * @property {AccountScope=} scope
 * @property {string=} cwd
 * @property {string=} credentialDir
 * @property {string=} policyFile
 * @property {number=} version
 */

/**
 * Read session account metadata without opening any credential file.
 *
 * The session header's cwd is authoritative for directory classification. If
 * a session contains more than one scope marker, company wins permanently so
 * an old company turn cannot be downgraded by a later personal-looking entry.
 * Malformed or unrelated JSONL entries are ignored because Pi may append
 * extension entries from versions this helper does not know. A recognized
 * account marker is different: it is part of the scope contract, so an
 * invalid version or scope fails closed instead of making a company session
 * look personal.
 *
 * @param {string} sessionFile
 * @returns {AccountSessionMetadata}
 */
export function readAccountSessionMetadata(sessionFile) {
  if (typeof sessionFile !== "string" || sessionFile.trim().length === 0) {
    throw new TypeError("Session file is required");
  }
  validateAccountSessionFile(sessionFile);

  let raw;
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch (error) {
    // A missing session is common while Pi is creating a new session. The
    // guard will classify it from the runtime context and persist once Pi has
    // created the file; callers do not need to special-case ENOENT.
    if (error?.code === "ENOENT") return {};
    throw new Error(`Unable to read Pi session metadata: ${sessionFile}`, { cause: error });
  }

  let headerCwd;
  let selected;
  let selectedRank = -1;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry)) continue;

    if (entry.type === "session" && typeof entry.cwd === "string" && !headerCwd) {
      headerCwd = nonEmpty(entry.cwd);
    }

    const metadata = metadataFromEntry(entry);
    if (!metadata?.scope) continue;
    const rank = metadata.scope === "company" ? 2 : 1;
    // Keep the last marker in file order within the winning scope. A personal
    // marker after company is deliberately ignored because company is
    // monotonic.
    if (rank >= selectedRank) {
      selected = metadata;
      selectedRank = rank;
    }
  }

  if (!selected && !headerCwd) return {};
  const result = {
    ...(selected ?? {}),
    ...(headerCwd ? { cwd: headerCwd } : {}),
  };
  delete result._sequence;
  return result;
}

/**
 * Backward-compatible name used by the guard and by callers that care about
 * the sticky scope rather than the full metadata shape.
 *
 * @param {string} sessionFile
 * @returns {AccountSessionMetadata}
 */
export function readAccountSessionScope(sessionFile) {
  return readAccountSessionMetadata(sessionFile);
}

/**
 * Build the Pi custom entry used for durable scope propagation.
 *
 * @param {AccountSessionMetadata & {scope: AccountScope, credentialDir: string, policyFile: string, cwd: string}} selection
 * @param {string=} parentId
 */
export function createAccountSessionEntry(selection, parentId) {
  assertSelection(selection);
  return {
    type: "custom",
    customType: ACCOUNT_SESSION_CUSTOM_TYPE,
    id: randomUUID(),
    ...(typeof parentId === "string" && parentId.trim() ? { parentId: parentId.trim() } : {}),
    timestamp: new Date().toISOString(),
    data: {
      version: ACCOUNT_SESSION_VERSION,
      scope: selection.scope,
      credentialDir: selection.credentialDir,
      policyFile: selection.policyFile,
      cwd: selection.cwd,
    },
  };
}

/**
 * Append a durable scope marker before a model request or before a child is
 * launched. Existing company metadata always wins; a personal caller can
 * never append a downgrade marker over it.
 *
 * @param {string} sessionFile
 * @param {AccountSessionMetadata & {scope: AccountScope, credentialDir: string, policyFile: string, cwd: string}} selection
 * @param {string=} parentId
 * @returns {{appended: boolean, metadata: AccountSessionMetadata, entry?: object}}
 */
export function persistAccountSessionScope(sessionFile, selection, parentId) {
  assertSelection(selection);
  validateAccountSessionFile(sessionFile, { requireHeader: true, allowMissing: false });
  const existing = readAccountSessionMetadata(sessionFile);
  if (existing.scope === "company" && selection.scope !== "company") {
    throw new Error("Cannot downgrade a company-scoped Pi session to personal");
  }
  const effective = selection;

  if (
    existing.scope === effective.scope &&
    existing.credentialDir === effective.credentialDir &&
    existing.policyFile === effective.policyFile &&
    existing.cwd === effective.cwd
  ) {
    return { appended: false, metadata: existing };
  }

  const raw = readSessionForAppend(sessionFile);
  const inferredParentId = parentId ?? lastEntryId(raw);
  const entry = createAccountSessionEntry(effective, inferredParentId);
  const prefix = raw.length > 0 && !/[\r\n]$/.test(raw) ? "\n" : "";
  appendFileSync(sessionFile, `${prefix}${JSON.stringify(entry)}\n`, "utf8");
  return {
    appended: true,
    metadata: { ...effective, version: ACCOUNT_SESSION_VERSION },
    entry,
  };
}

/** Alias kept explicit for integrations that describe this as an append. */
export const appendAccountSessionScope = persistAccountSessionScope;

function readSessionForAppend(sessionFile) {
  try {
    return readFileSync(sessionFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw new Error(`Unable to read Pi session metadata: ${sessionFile}`, { cause: error });
  }
}

function lastEntryId(raw) {
  const lines = raw.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trim()) continue;
    try {
      const entry = JSON.parse(lines[index]);
      if (isObject(entry) && typeof entry.id === "string" && entry.id.trim()) return entry.id;
    } catch {
      // A partial final line has no usable parent; append after it with a
      // newline so the existing content is preserved for Pi to diagnose.
    }
    break;
  }
  return undefined;
}

function metadataFromEntry(entry) {
  const isScopeEntry = entry.type === "custom" && entry.customType === ACCOUNT_SESSION_CUSTOM_TYPE;
  const isLegacyScopeEntry = entry.type === ACCOUNT_SESSION_CUSTOM_TYPE;
  if (!isScopeEntry && !isLegacyScopeEntry) return undefined;
  const data = isObject(entry.data) ? entry.data : entry;
  if (data.version !== ACCOUNT_SESSION_VERSION) {
    throw new Error(`Unsupported Pi account scope metadata version: ${String(data.version)}`);
  }
  if (!ACCOUNT_SCOPES.has(data.scope)) {
    throw new Error("Invalid Pi account scope metadata");
  }
  for (const key of ["cwd", "credentialDir", "policyFile"]) {
    if (data[key] !== undefined && nonEmpty(data[key]) === undefined) {
      throw new Error(`Invalid Pi account scope metadata field: ${key}`);
    }
  }
  const metadata = {
    scope: data.scope,
    ...(nonEmpty(data.cwd) ? { cwd: nonEmpty(data.cwd) } : {}),
    ...(nonEmpty(data.credentialDir) ? { credentialDir: nonEmpty(data.credentialDir) } : {}),
    ...(nonEmpty(data.policyFile) ? { policyFile: nonEmpty(data.policyFile) } : {}),
    ...(typeof data.version === "number" ? { version: data.version } : {}),
  };
  return metadata;
}

function assertSelection(selection) {
  if (!isObject(selection) || !ACCOUNT_SCOPES.has(selection.scope)) {
    throw new TypeError("Account selection must contain a personal or company scope");
  }
  for (const key of ["credentialDir", "policyFile", "cwd"]) {
    if (typeof selection[key] !== "string" || selection[key].trim().length === 0) {
      throw new TypeError(`Account selection requires '${key}'`);
    }
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
