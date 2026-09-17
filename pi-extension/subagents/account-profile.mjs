import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath } from "./account-scope.mjs";

const SHARED_RESOURCES = ["extensions", "skills", "prompts", "themes"];

/** Validate the selected store before creating Pi or a Paseo agent.
 * Pi owns parsing/validating credential data. This helper never returns,
 * logs, copies, links, refreshes, or rewrites credentials.
 */
export async function prepareAccountProfile(selection, policy) {
  const expected = selection.scope === "company" ? policy.companyAgentDir : policy.personalAgentDir;
  if (!["personal", "company"].includes(selection.scope) || canonicalPath(selection.credentialDir) !== expected) {
    throw new Error("Selected credential directory does not match the account policy");
  }
  const dir = selection.credentialDir;
  const authPath = join(dir, "auth.json");
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error("not a directory");
    const auth = lstatSync(authPath);
    if (!auth.isFile() || auth.isSymbolicLink() || auth.nlink !== 1) throw new Error("auth must be a private regular file");
    accessSync(authPath, constants.R_OK | constants.W_OK);
    accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(`${selection.scope} account profile is unavailable or auth.json is not a readable, writable, private regular file. Authenticate independently with Pi /login in the configured profile; no account fallback is allowed.`);
  }
  // Use the supported Pi API, without asking it to resolve a key or refresh.
  const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
  let valid = false;
  try {
    const auth = AuthStorage.create(authPath);
    const credential = auth.get("openai-codex");
    valid = !auth.drainErrors().length && credential?.type === "oauth" &&
      typeof credential.access === "string" && !!credential.access &&
      typeof credential.refresh === "string" && !!credential.refresh &&
      typeof credential.expires === "number" && Number.isFinite(credential.expires);
  } catch { /* Never propagate parsing errors that may quote credential data. */ }
  if (!valid) {
    throw new Error(`${selection.scope} account requires independent openai-codex OAuth authentication in its selected Pi profile; API-key or environment fallback is not allowed.`);
  }
  if (policy.sharedConfigDir) {
    const sharedSettings = join(policy.sharedConfigDir, "settings.json");
    if (existsSync(sharedSettings) && lstatSync(sharedSettings).isFile()) {
      try { copyFileSync(sharedSettings, join(dir, "settings.json"), constants.COPYFILE_EXCL); }
      catch (error) {
        if (error.code !== "EEXIST") throw new Error("Unable to initialize absent profile settings from shared configuration");
      }
    }
    // Existing profile settings/resources remain authoritative. Only these
    // noncredential resource directories are eligible for additive sharing.
    for (const resource of SHARED_RESOURCES) {
      const source = join(policy.sharedConfigDir, resource);
      const target = join(dir, resource);
      if (!existsSync(source)) continue;
      try { lstatSync(target); continue; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!lstatSync(source).isDirectory()) continue;
      mkdirSync(dir, { recursive: true });
      try { symlinkSync(source, target, "dir"); } catch (error) {
        if (error.code !== "EEXIST") throw new Error(`Unable to share noncredential resource '${resource}'`);
      }
    }
  }
  return selection;
}
