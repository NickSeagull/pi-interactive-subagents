import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * @typedef {"personal" | "company"} AccountScope
 *
 * @typedef {Object} AccountPolicy
 * @property {string} policyFile Absolute canonical path of the policy file.
 * @property {string} personalAgentDir Canonical credential/config directory for personal work.
 * @property {string} companyAgentDir Canonical credential/config directory for company work.
 * @property {string[]} companyRoots Canonical directory roots that imply company scope.
 * @property {string=} sharedConfigDir Optional shared non-credential Pi configuration directory.
 *
 * @typedef {Object} AccountSelection
 * @property {AccountScope} scope
 * @property {string} credentialDir
 * @property {string} policyFile
 * @property {string} reason
 * @property {string} cwd Canonical session cwd used for classification.
 */

const SCOPES = new Set(["personal", "company"]);

/**
 * Resolve a path through all existing symlinked components while preserving
 * the suffix that does not exist yet. This is used for future credential
 * directories and company roots, so it must not require those directories to
 * have been provisioned already.
 *
 * @param {string} value
 * @param {string=} baseDir
 * @returns {string}
 */
export function canonicalPath(value, baseDir = process.cwd()) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Path must be a non-empty string");
  }

  const expanded = expandPath(value, baseDir);
  const absolute = resolve(expanded);
  let existing = absolute;
  const suffix = [];

  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      break;
    }
    suffix.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    existing = parent;
  }

  let canonicalExisting;
  try {
    canonicalExisting = realpathSync.native(existing);
  } catch (error) {
    throw new Error(`Unable to resolve path '${absolute}'`, { cause: error });
  }

  return suffix.length > 0 ? join(canonicalExisting, ...suffix) : canonicalExisting;
}

/**
 * Load and normalize one explicitly selected account policy file.
 *
 * Only this policy file is read. In particular, this function never opens or
 * inspects auth.json (or any other credential file), and it never provisions
 * missing directories.
 *
 * @param {string} file
 * @returns {AccountPolicy}
 */
export function loadAccountPolicy(file) {
  if (typeof file !== "string" || file.trim().length === 0) {
    throw new TypeError("Account policy file is required");
  }

  const absolutePolicyFile = canonicalPath(file);
  let raw;
  try {
    raw = JSON.parse(readFileSync(absolutePolicyFile, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Account policy is not valid JSON: ${absolutePolicyFile}`, { cause: error });
    }
    throw new Error(`Unable to read account policy: ${absolutePolicyFile}`, { cause: error });
  }

  if (!isPlainObject(raw)) {
    throw new Error(`Account policy must be a JSON object: ${absolutePolicyFile}`);
  }

  const policyDir = dirname(absolutePolicyFile);
  const personalAgentDir = requiredPath(raw, "personalAgentDir", policyDir);
  const companyAgentDir = requiredPath(raw, "companyAgentDir", policyDir);
  const companyRoots = requiredPathArray(raw, "companyRoots", policyDir);
  const sharedConfigDir = optionalPath(raw, "sharedConfigDir", policyDir);

  if (pathsOverlap(personalAgentDir, companyAgentDir)) {
    throw new Error("personalAgentDir and companyAgentDir must not overlap");
  }

  /** @type {AccountPolicy} */
  const policy = {
    policyFile: absolutePolicyFile,
    personalAgentDir,
    companyAgentDir,
    companyRoots,
  };
  if (sharedConfigDir !== undefined) {
    policy.sharedConfigDir = sharedConfigDir;
  }
  return policy;
}

/**
 * Resolve the sticky account scope for a session. Company scope is
 * deliberately monotonic: a company parent, persisted company marker, or
 * explicit company override wins even when the current cwd is outside all
 * company roots. A company cwd also upgrades a personal parent.
 *
 * @param {Object} input
 * @param {AccountPolicy} input.policy
 * @param {string} input.cwd Session cwd, classified once at session start.
 * @param {AccountScope|null|undefined} [input.parentScope]
 * @param {AccountScope|null|undefined} [input.persistedScope]
 * @param {boolean} [input.forceCompany]
 * @returns {AccountSelection}
 */
export function resolveAccountSelection({
  policy,
  cwd,
  parentScope,
  persistedScope,
  forceCompany = false,
}) {
  assertPolicy(policy);
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    throw new TypeError("Session cwd is required");
  }
  if (typeof forceCompany !== "boolean") {
    throw new TypeError("forceCompany must be a boolean");
  }

  const normalizedParentScope = validateOptionalScope(parentScope, "parentScope");
  const normalizedPersistedScope = validateOptionalScope(persistedScope, "persistedScope");
  const canonicalCwd = canonicalPath(cwd);

  let scope = "personal";
  let reason = "default-personal";
  if (forceCompany) {
    scope = "company";
    reason = "explicit-company-override";
  } else if (normalizedPersistedScope === "company") {
    scope = "company";
    reason = "persisted-company-scope";
  } else if (normalizedParentScope === "company") {
    scope = "company";
    reason = "company-parent-scope";
  } else if (isCompanyPath(canonicalCwd, policy.companyRoots)) {
    scope = "company";
    reason = "company-directory-rule";
  } else if (normalizedPersistedScope === "personal") {
    reason = "persisted-personal-scope";
  } else if (normalizedParentScope === "personal") {
    reason = "personal-parent-scope";
  }

  const credentialDir = scope === "company" ? policy.companyAgentDir : policy.personalAgentDir;
  return {
    scope,
    credentialDir,
    policyFile: policy.policyFile,
    reason,
    cwd: canonicalCwd,
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} input
 * @param {string} key
 * @param {string} baseDir
 * @returns {string}
 */
function requiredPath(input, key, baseDir) {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Account policy requires '${key}'`);
  }
  return canonicalPath(value, baseDir);
}

/**
 * @param {Record<string, unknown>} input
 * @param {string} key
 * @param {string} baseDir
 * @returns {string[]}
 */
function requiredPathArray(input, key, baseDir) {
  const value = input[key];
  if (!Array.isArray(value)) {
    throw new Error(`Account policy requires '${key}' as an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`Account policy '${key}[${index}]' must be a non-empty string`);
    }
    return canonicalPath(entry, baseDir);
  });
}

/**
 * @param {Record<string, unknown>} input
 * @param {string} key
 * @param {string} baseDir
 * @returns {string|undefined}
 */
function optionalPath(input, key, baseDir) {
  if (!(key in input) || input[key] === undefined || input[key] === null) {
    return undefined;
  }
  if (typeof input[key] !== "string" || input[key].trim().length === 0) {
    throw new Error(`Account policy '${key}' must be a non-empty string when provided`);
  }
  return canonicalPath(input[key], baseDir);
}

/**
 * @param {AccountPolicy} policy
 */
function assertPolicy(policy) {
  if (!isPlainObject(policy)) {
    throw new TypeError("A normalized account policy is required");
  }
  if (
    typeof policy.policyFile !== "string" ||
    typeof policy.personalAgentDir !== "string" ||
    typeof policy.companyAgentDir !== "string" ||
    !Array.isArray(policy.companyRoots)
  ) {
    throw new TypeError("Invalid normalized account policy");
  }
  if (pathsOverlap(policy.personalAgentDir, policy.companyAgentDir)) {
    throw new Error("personalAgentDir and companyAgentDir must not overlap");
  }
}

/**
 * @param {AccountScope|null|undefined} value
 * @param {string} name
 * @returns {AccountScope|null}
 */
function validateOptionalScope(value, name) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !SCOPES.has(value)) {
    throw new Error(`${name} must be 'personal' or 'company'`);
  }
  return value;
}

/**
 * @param {string} cwd
 * @param {string[]} roots
 * @returns {boolean}
 */
function isCompanyPath(cwd, roots) {
  return roots.some((root) => {
    const candidate = canonicalPath(root);
    const remainder = relative(candidate, cwd);
    return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
  });
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function pathsOverlap(left, right) {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return (
    leftToRight === "" ||
    rightToLeft === "" ||
    (leftToRight !== ".." && !leftToRight.startsWith(`..${sep}`) && !isAbsolute(leftToRight)) ||
    (rightToLeft !== ".." && !rightToLeft.startsWith(`..${sep}`) && !isAbsolute(rightToLeft))
  );
}

/**
 * @param {string} value
 * @param {string} baseDir
 * @returns {string}
 */
function expandPath(value, baseDir) {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return isAbsolute(value) ? value : resolve(baseDir, value);
}
