import { fileURLToPath } from "node:url";
import { loadAccountPolicy, resolveAccountSelection } from "./account-scope.mjs";
import { readAccountSessionMetadata, validateAccountSessionFile } from "./account-session.mjs";

/** Prepare a terminal child with the same policy as a managed Paseo child.
 * Credential routing is returned as explicit child environment, never applied
 * to the calling process. The launcher repeats preflight in the child process.
 */
export async function prepareScopedLaunch({ cwd, parentSessionFile, sessionFile, env = process.env }) {
  if (sessionFile) validateAccountSessionFile(sessionFile, { requireHeader: true });
  const parent = parentSessionFile ? readAccountSessionMetadata(parentSessionFile) : {};
  const persisted = sessionFile ? readAccountSessionMetadata(sessionFile) : {};
  const scopes = [env.PI_ACCOUNT_SCOPE, env.PI_ACCOUNT_PROVIDER_SCOPE, parent.scope, persisted.scope];
  for (const scope of scopes) {
    if (scope !== undefined && scope !== "personal" && scope !== "company") {
      throw new Error("Invalid inherited account scope");
    }
  }
  const policyFile = env.PI_ACCOUNT_POLICY_FILE ?? persisted.policyFile ?? parent.policyFile;
  if (!policyFile) {
    if (scopes.some((scope) => scope !== undefined)) throw new Error("Account scope requires an explicit account policy file");
    return undefined;
  }
  const policy = loadAccountPolicy(policyFile);
  const inherited = resolveAccountSelection({
    policy, cwd, parentScope: scopes.includes("company") ? "company" : parent.scope ?? env.PI_ACCOUNT_SCOPE,
  });
  const selection = resolveAccountSelection({
    policy, cwd: persisted.cwd ?? cwd,
    parentScope: inherited.scope,
    persistedScope: persisted.scope,
  });
  const { prepareAccountProfile } = await import("./account-profile.mjs");
  await prepareAccountProfile(selection, policy);
  return {
    ...selection,
    command: [process.execPath, fileURLToPath(new URL("../../bin/pi-scoped.mjs", import.meta.url)),
      "--config", selection.policyFile, ...(selection.scope === "company" ? ["--company"] : []), "--"],
    env: {
      PI_CODING_AGENT_DIR: selection.credentialDir,
      PI_ACCOUNT_SCOPE: selection.scope,
      PI_ACCOUNT_PROVIDER_SCOPE: selection.scope,
      PI_ACCOUNT_POLICY_FILE: selection.policyFile,
      PI_ACCOUNT_LAUNCHER: "1",
    },
  };
}
