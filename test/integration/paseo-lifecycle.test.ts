/**
 * Opt-in acceptance checks for a Pi parent launched by Paseo itself.
 *
 * The parent is created through the public Paseo SDK. Its environment points
 * at an explicitly configured canonical Pi account directory; the scoped
 * provider alias must launch the repository's account-aware launcher. No
 * auth overlay, mux surface, or borrowed parent ID is involved in this test.
 *
 * Run against an isolated daemon with a Pi provider, for example:
 *
 *   PI_TEST_PASEO=1 \
 *   PI_TEST_PASEO_HOST=127.0.0.1:6879 \
 *   PI_TEST_ACCOUNT_POLICY_FILE=/absolute/path/to/account-policy.json \
 *   PI_TEST_AGENT_DIR=/absolute/path/to/pi-personal \
 *   PI_TEST_SCOPED_LAUNCHER=/absolute/path/to/pi-interactive-subagents/bin/pi-scoped.mjs \
 *   PI_TEST_MODEL=openai-codex/gpt-5.6-luna \
 *   npm run test:paseo
 *
 * The control and reconnect cases can be enabled with
 * PI_TEST_PASEO_CONTROLS=1 and PI_TEST_PASEO_RECONNECT=1 respectively.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPaseoClient, type PaseoAgentHandle, type PaseoClient } from "@getpaseo/client";
import { accessSync, constants, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PaseoBackend } from "../../pi-extension/subagents/paseo.ts";
import {
  canonicalPath,
  loadAccountPolicy,
  resolveAccountSelection,
} from "../../pi-extension/subagents/account-scope.mjs";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const enabled = process.env.PI_TEST_PASEO === "1";
const hostInput = process.env.PI_TEST_PASEO_HOST ?? process.env.PASEO_HOST ?? process.env.PASEO_URL ?? "127.0.0.1:6767";
const model = process.env.PI_TEST_MODEL ?? "openai-codex/gpt-5.6-luna";
const testTimeout = Number(process.env.PI_TEST_TIMEOUT ?? "180000");
const reconnectEnabled = process.env.PI_TEST_PASEO_RECONNECT === "1";
const controlsEnabled = process.env.PI_TEST_PASEO_CONTROLS === "1";

type TestAccountSetup = {
  policy: ReturnType<typeof loadAccountPolicy>;
  profileDir: string;
  profileScope: "personal" | "company";
  launcherPath: string;
};

type TestAccountState = TestAccountSetup & {
  selection: ReturnType<typeof resolveAccountSelection>;
  provider: "pi-personal" | "pi-company";
};

/**
 * Check only metadata needed to decide whether the opt-in live suite can run.
 * The auth file is never opened or parsed here. Pi's account preflight remains
 * responsible for rejecting a missing or non-OAuth profile before a request.
 */
function inspectTestAccountSetup(): { setup?: TestAccountSetup; reason?: string } {
  const policyFile = process.env.PI_TEST_ACCOUNT_POLICY_FILE?.trim();
  const profileInput = process.env.PI_TEST_AGENT_DIR?.trim();
  const launcherInput = process.env.PI_TEST_SCOPED_LAUNCHER?.trim();
  if (!policyFile || !profileInput || !launcherInput) {
    return {
      reason:
        "Set PI_TEST_ACCOUNT_POLICY_FILE, PI_TEST_AGENT_DIR, and PI_TEST_SCOPED_LAUNCHER to run the opt-in suite.",
    };
  }

  let policy: ReturnType<typeof loadAccountPolicy>;
  let profileDir: string;
  let launcherPath: string;
  try {
    policy = loadAccountPolicy(policyFile);
    profileDir = canonicalPath(profileInput);
    launcherPath = canonicalPath(launcherInput);
  } catch (error) {
    return { reason: `Account test setup is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }

  let profileScope: "personal" | "company";
  if (profileDir === policy.personalAgentDir) profileScope = "personal";
  else if (profileDir === policy.companyAgentDir) profileScope = "company";
  else {
    return {
      reason:
        "PI_TEST_AGENT_DIR must resolve exactly to personalAgentDir or companyAgentDir in PI_TEST_ACCOUNT_POLICY_FILE.",
    };
  }

  try {
    const profile = statSync(profileDir);
    if (!profile.isDirectory()) return { reason: `Configured Pi profile is not a directory: ${profileDir}` };
    const auth = statSync(join(profileDir, "auth.json"));
    if (!auth.isFile() || auth.size <= 0) {
      return { reason: `Configured Pi profile has no readable auth.json: ${profileDir}` };
    }
    accessSync(join(profileDir, "auth.json"), constants.R_OK);
    const launcher = statSync(launcherPath);
    if (!launcher.isFile()) return { reason: `Scoped launcher is not a file: ${launcherPath}` };
  } catch (error) {
    return {
      reason: `Account test profile or launcher is not provisioned: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { setup: { policy, profileDir, profileScope, launcherPath } };
}

const accountSetup = enabled
  ? inspectTestAccountSetup()
  : { reason: "Set PI_TEST_PASEO=1 to run the live Paseo integration tests." };

function websocketUrl(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("ws://") || value.startsWith("wss://")) {
    const url = new URL(value);
    if (!url.pathname || url.pathname === "/") url.pathname = "/ws";
    return url.toString();
  }
  if (value.startsWith("tcp://")) {
    const url = new URL(value);
    const protocol = url.searchParams.get("ssl") === "true" ? "wss:" : "ws:";
    return `${protocol}//${url.host}/ws`;
  }
  if (/^\d+$/.test(value)) return `ws://127.0.0.1:${value}/ws`;
  return `ws://${value}/ws`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor<T>(
  description: string,
  read: () => Promise<T | undefined> | T | undefined,
  predicate: (value: T) => boolean = () => true,
  timeout = testTimeout,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined && predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`);
}

async function waitForFile(path: string, pattern: RegExp, timeout = testTimeout): Promise<string> {
  return waitFor(`file ${path}`, () => {
    try {
      const contents = readFileSync(path, "utf8");
      return pattern.test(contents) ? contents : undefined;
    } catch {
      return undefined;
    }
  }, undefined, timeout);
}

function agentFromEntry(entry: any): any {
  return entry?.agent ?? entry;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForChild(
  client: PaseoClient,
  title: string,
  timeout = testTimeout,
): Promise<{ handle: PaseoAgentHandle; snapshot: any }> {
  return waitFor(`Paseo child ${title}`, async () => {
    const result = await client.agents.list({ includeArchived: true } as any);
    const entry = result.entries.find((candidate: any) => agentFromEntry(candidate)?.title === title);
    if (!entry) return undefined;
    const snapshot = agentFromEntry(entry);
    return { handle: client.agents.ref(snapshot.id), snapshot };
  }, undefined, timeout);
}

async function timelineText(agent: PaseoAgentHandle): Promise<string> {
  const page = await agent.timeline.refetch({ direction: "tail", limit: 200 });
  return JSON.stringify(page.entries);
}

function readJsonLines(path: string): any[] {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function customMessage(entry: any): { type: string; details: any; entry: any } | undefined {
  if (entry?.type !== "custom_message" && entry?.message?.type !== "custom_message") return undefined;
  const source = entry?.message?.type === "custom_message" ? entry.message : entry;
  return {
    type: source.customType ?? entry.customType ?? "",
    details: source.details ?? entry.details ?? {},
    entry,
  };
}

async function waitForParentMessage(
  sessionFile: string,
  kind: "result" | "ping",
  name: string,
  timeout = testTimeout,
): Promise<{ type: string; details: any; entry: any }> {
  return waitFor(`parent ${kind} message for ${name}`, () => {
    const accepted = kind === "result"
      ? new Set(["subagent_result", "subagent_complete"])
      : new Set(["subagent_ping"]);
    for (const entry of readJsonLines(sessionFile)) {
      const message = customMessage(entry);
      if (message && accepted.has(message.type) && message.details?.name === name) return message;
    }
    return undefined;
  }, undefined, timeout);
}

function assertNewDelivery(
  message: { type: string; details: any; entry: any },
  expectedAgentId: string,
  seen: Set<string>,
): string {
  const deliveryId = message.details?.paseoDeliveryId;
  assert.equal(typeof deliveryId, "string", "Paseo result must carry a durable delivery ID");
  assert.ok(deliveryId.length > 0);
  assert.equal(message.details?.paseoAgentId, expectedAgentId);
  assert.equal(seen.has(deliveryId), false, `delivery ID ${deliveryId} was replayed`);
  seen.add(deliveryId);
  return deliveryId;
}

function sessionFileFromMessage(message: { details: any }): string {
  const path = message.details?.sessionFile;
  assert.equal(typeof path, "string", "Paseo result must include the child session path");
  return path;
}

async function waitForSessionEntry(
  path: string,
  predicate: (entry: any) => boolean,
  description: string,
  timeout = testTimeout,
): Promise<any> {
  return waitFor(description, () => {
    const entry = readJsonLines(path).find(predicate);
    return entry;
  }, undefined, timeout);
}

async function waitForTimeline(
  agent: PaseoAgentHandle,
  pattern: RegExp,
  description: string,
  timeout = testTimeout,
): Promise<string> {
  return waitFor(description, async () => {
    const text = await timelineText(agent);
    return pattern.test(text) ? text : undefined;
  }, undefined, timeout);
}

function shellMarkerTask(marker: string, value: string, trailing = "then call subagent_done") {
  return `Use bash exactly as needed: printf '%s\\n' '${value}' > '${marker}'; ${trailing}.`;
}

function accountEnvironment(account: TestAccountState): Record<string, string> {
  return {
    PI_CODING_AGENT_DIR: account.selection.credentialDir,
    PI_ACCOUNT_SCOPE: account.selection.scope,
    PI_ACCOUNT_PROVIDER_SCOPE: account.selection.scope,
    PI_ACCOUNT_POLICY_FILE: account.selection.policyFile,
    PI_ACCOUNT_LAUNCHER: "1",
  };
}

function assertAccountSnapshot(snapshot: any, account: TestAccountState): void {
  assert.equal(snapshot.provider, account.provider, "Paseo must retain the selected account provider alias");
  assert.equal(
    snapshot.labels?.["pi-account-scope"],
    account.selection.scope,
    "Paseo status must expose the selected account scope",
  );
}

describe(
  "Paseo native Pi integration",
  { skip: accountSetup.setup ? false : accountSetup.reason, timeout: testTimeout * 5 },
  () => {
    let root = "";
    let parentProject = "";
    let otherProject = "";
    let account!: TestAccountState;
    let client: PaseoClient;
    let parent: PaseoAgentHandle;
    let parentSessionFile = "";
    const deliveryIds = new Set<string>();
    const childIds: string[] = [];

    before(async () => {
      root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pi-paseo-sdk-integration-"));
      parentProject = join(root, "parent-project");
      otherProject = join(root, "other-project");
      mkdirSync(parentProject, { recursive: true });
      mkdirSync(otherProject, { recursive: true });

      // The profile path is part of the explicit test contract. Treat its
      // scope as an inherited provider lower bound, then classify this actual
      // session cwd with the shared policy helper. A personal profile is
      // upgraded if the test cwd is company-scoped; a company profile remains
      // company outside those roots. A mismatch fails before Paseo is asked
      // to create a model process.
      const setup = accountSetup.setup!;
      const selection = resolveAccountSelection({
        policy: setup.policy,
        cwd: parentProject,
        parentScope: setup.profileScope,
      });
      if (selection.credentialDir !== setup.profileDir) {
        throw new Error(
          `PI_TEST_AGENT_DIR does not satisfy the selected scope for test cwd ${selection.cwd}; ` +
          `the policy selected ${selection.scope} credentials.`,
        );
      }
      const provider = selection.scope === "company" ? "pi-company" : "pi-personal";
      const configuredProvider = process.env.PI_TEST_PASEO_PROVIDER?.trim();
      if (configuredProvider && configuredProvider !== provider) {
        throw new Error(
          `PI_TEST_PASEO_PROVIDER must match the policy selection (${provider}); received ${configuredProvider}.`,
        );
      }
      account = { ...setup, selection, provider };

      const definitionsDir = join(parentProject, ".pi", "agents");
      mkdirSync(definitionsDir, { recursive: true });
      writeFileSync(join(definitionsDir, "acceptance.md"), [
        "---", "name: acceptance", "description: Native Paseo acceptance worker",
        "auto-exit: true", `model: ${model}`, "thinking: max", "tools: bash",
        "---", "Complete only the assigned task and report the result.",
      ].join("\n"));

      const accountEnv = accountEnvironment(account);
      const password = process.env.PASEO_PASSWORD;
      client = createPaseoClient({
        url: websocketUrl(hostInput),
        password,
        clientId: `pi-paseo-sdk-integration-${process.pid}`,
        connectTimeoutMs: Math.max(30_000, testTimeout),
        reconnect: { enabled: true, baseDelayMs: 250, maxDelayMs: 5_000 },
      });
      await client.connect();
      parent = await client.agents.create({
        config: { provider: `${account.provider}/${model}`, thinkingOptionId: "max" },
        cwd: parentProject,
        title: `Pi Paseo acceptance parent ${process.pid}`,
        env: {
          ...accountEnv,
          PASEO_HOST: hostInput,
          ...(password ? { PASEO_PASSWORD: password } : {}),
        },
        labels: {
          "pi-account-scope": account.selection.scope,
          "pi-account-provider-scope": account.selection.scope,
          "pi-account-provider": account.provider,
          "pi-account-policy-file": account.selection.policyFile,
        },
      });

      // Commands are queried from the live provider, which proves the native
      // parent was launched through the configured scoped provider alias and
      // loaded the extension before any child starts.
      const commands = await parent.commands();
      assert.equal(commands.error, null, commands.error ?? "Pi command discovery failed");
      assert.ok(commands.commands.some((entry) => entry.name === "subagent"), "native parent loaded subagent");
      const refreshed = await parent.refresh();
      const nativeHandle = (refreshed?.agent.persistence as any)?.nativeHandle;
      assert.equal(typeof nativeHandle, "string", "Paseo parent must expose its native Pi session");
      parentSessionFile = nativeHandle;
    });

    after(async () => {
      if (client) {
        for (const childId of childIds) {
          await client.agents.ref(childId).archive().catch(() => undefined);
        }
        if (parent) await parent.archive().catch(() => undefined);
        await client.close().catch(() => undefined);
      }
      if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    it("creates native children, delivers results, preserves fork lineage, and opens a cross-project workspace", async () => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
      const sameMarker = join(parentProject, `same-${id}.txt`);
      const forkMarker = join(parentProject, `fork-${id}.txt`);
      const crossMarker = join(otherProject, `cross-${id}.txt`);

      const sameTitle = `Paseo same ${id}`;
      await parent.run([
        "Call the subagent tool exactly once and then end your turn.",
        `name: ${sameTitle}`,
        `model: ${model}`,
        "agent: acceptance",
        "tools: bash",
        `task: ${shellMarkerTask(sameMarker, `SAME_${id}`)}`,
      ].join("\n"), { timeoutMs: testTimeout });
      const same = await waitForChild(client, sameTitle);
      childIds.push(same.snapshot.id);
      await waitForFile(sameMarker, /SAME_/);
      assertAccountSnapshot(same.snapshot, account);
      assert.equal(same.snapshot.labels?.["paseo.parent-agent-id"], parent.id, "Paseo records the native parent relationship");
      assert.equal(realpathSync(same.snapshot.cwd), realpathSync(parentProject));
      assert.equal(same.snapshot.workspaceId, parent.workspaceId, "same-project child stays in the parent workspace");
      const sameResult = await waitForParentMessage(parentSessionFile, "result", sameTitle);
      const sameDeliveryId = assertNewDelivery(sameResult, same.snapshot.id, deliveryIds);
      assert.equal(sameResult.details.exitCode, 0);
      assert.equal((await same.handle.refresh())?.agent.status, "idle", "successful completion stays idle in Paseo");

      const forkTitle = `Paseo fork ${id}`;
      await parent.run([
        "Call the subagent tool exactly once with fork true and then end your turn.",
        `name: ${forkTitle}`,
        "fork: true",
        `model: ${model}`,
        "agent: acceptance",
        "tools: bash",
        `task: ${shellMarkerTask(forkMarker, `FORK_${id}`)}`,
      ].join("\n"), { timeoutMs: testTimeout });
      const fork = await waitForChild(client, forkTitle);
      childIds.push(fork.snapshot.id);
      await waitForFile(forkMarker, /FORK_/);
      assertAccountSnapshot(fork.snapshot, account);
      assert.equal(fork.snapshot.labels?.["paseo.parent-agent-id"], parent.id, "Paseo records the native parent relationship");
      const forkResult = await waitForParentMessage(parentSessionFile, "result", forkTitle);
      const forkDeliveryId = assertNewDelivery(forkResult, fork.snapshot.id, deliveryIds);
      assert.equal(forkResult.details.exitCode, 0);
      assert.equal((await fork.handle.refresh())?.agent.status, "idle", "successful completion stays idle in Paseo");
      const forkSessionFile = sessionFileFromMessage(forkResult);
      const forkEntries = await waitForSessionEntry(
        forkSessionFile,
        (entry) => entry?.type === "session",
        `fork session header for ${forkTitle}`,
      );
      assert.equal(typeof forkEntries.parentSession, "string");
      assert.equal(realpathSync(forkEntries.parentSession), realpathSync(parentSessionFile));
      assert.ok(
        readJsonLines(forkSessionFile).some((entry) => JSON.stringify(entry).includes(sameTitle)),
        "fork session must retain the parent's earlier conversation",
      );

      const crossTitle = `Paseo cross ${id}`;
      await parent.run([
        "Call the subagent tool exactly once and then end your turn.",
        `name: ${crossTitle}`,
        `cwd: ${otherProject}`,
        `model: ${model}`,
        "agent: acceptance",
        "tools: bash",
        `task: ${shellMarkerTask(crossMarker, `CROSS_${id}`)}`,
      ].join("\n"), { timeoutMs: testTimeout });
      const cross = await waitForChild(client, crossTitle);
      childIds.push(cross.snapshot.id);
      await waitForFile(crossMarker, /CROSS_/);
      assertAccountSnapshot(cross.snapshot, account);
      assert.equal(cross.snapshot.labels?.["paseo.parent-agent-id"], parent.id, "Paseo records the native parent relationship");
      assert.equal(realpathSync(cross.snapshot.cwd), realpathSync(otherProject));
      assert.notEqual(cross.snapshot.workspaceId, parent.workspaceId, "cross-project child gets a separate workspace");
      const crossResult = await waitForParentMessage(parentSessionFile, "result", crossTitle);
      const crossDeliveryId = assertNewDelivery(crossResult, cross.snapshot.id, deliveryIds);
      assert.equal(crossResult.details.exitCode, 0);
      assert.equal((await cross.handle.refresh())?.agent.status, "idle", "successful completion stays idle in Paseo");
    });

    it("supports a help request and resumes the same child through Paseo", async () => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
      const title = `Paseo help ${id}`;
      const marker = join(parentProject, `help-${id}.txt`);
      await parent.run([
        "Call the subagent tool exactly once and then end your turn.",
        `name: ${title}`,
        `model: ${model}`,
        "agent: acceptance",
        "tools: bash",
        `task: Call caller_ping with message exactly HELP_${id}. Wait for a direct user follow-up in Paseo. After it arrives, ${shellMarkerTask(marker, `RESUMED_${id}`)}`,
      ].join("\n"), { timeoutMs: testTimeout });
      const child = await waitForChild(client, title);
      childIds.push(child.snapshot.id);
      assertAccountSnapshot(child.snapshot, account);
      const ping = await waitForParentMessage(parentSessionFile, "ping", title);
      const pingDeliveryId = assertNewDelivery(ping, child.snapshot.id, deliveryIds);

      await parent.run([
        `Use subagent_resume exactly once for agentId ${JSON.stringify(child.snapshot.id)}.`,
        `Send message: The user answered HELP_${id}; continue now and write the marker.`,
        "Set autoExit true, then end your turn.",
      ].join("\n"), { timeoutMs: testTimeout });
      await waitForFile(marker, /RESUMED_/);
      await waitForTimeline(child.handle, new RegExp(`RESUMED_${id}`), `resumed child timeline for ${title}`);
      const resumedResult = await waitForParentMessage(parentSessionFile, "result", title);
      const resumedDeliveryId = assertNewDelivery(resumedResult, child.snapshot.id, deliveryIds);
      assert.notEqual(resumedDeliveryId, pingDeliveryId, "resume must create a distinct completion delivery");
      assert.equal((await child.handle.refresh())?.agent.status, "idle");
    });

    it(
      "interrupts a native child through the parent extension",
      { skip: controlsEnabled ? false : "Set PI_TEST_PASEO_CONTROLS=1 to run the live interrupt acceptance case." },
      async () => {
        const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
        const title = `Paseo interrupt ${id}`;
        const marker = join(parentProject, `interrupt-${id}.txt`);
        await parent.run([
          "Call the subagent tool once with the long running task below.",
          `name: ${title}`,
          `model: ${model}`,
          "agent: acceptance",
          "tools: bash",
          `task: Run bash sleep 120; after sleep ${shellMarkerTask(marker, `SHOULD_NOT_RUN_${id}`)}`,
          `After the subagent tool returns, immediately call subagent_interrupt for ${title}, then end your turn.`,
        ].join("\n"), { timeoutMs: testTimeout });
        const child = await waitForChild(client, title);
        childIds.push(child.snapshot.id);
        await waitForTimeline(parent, new RegExp("interrupt_requested|interrupted|cancel", "i"), `interrupt result for ${title}`);
        await sleep(2_000);
        assert.equal(readFileSafe(marker), undefined, "interrupted child must not run the post-sleep task");
        const refreshed = await child.handle.refresh();
        const status = refreshed?.agent.status;
        assert.ok(status && ["closed", "idle", "error"].includes(status), `unexpected child status ${status}`);
      },
    );

    it(
      "restores a native child after its extension observer disconnects and acknowledges once",
      { skip: reconnectEnabled ? false : "Set PI_TEST_PASEO_RECONNECT=1 to run the live reconnect acceptance case." },
      async () => {
        const id = `reconnect-${Date.now().toString(36)}`;
        const accountEnv = {
          ...accountEnvironment(account),
          PASEO_HOST: hostInput,
          ...(process.env.PASEO_PASSWORD ? { PASEO_PASSWORD: process.env.PASEO_PASSWORD } : {}),
        };
        const options = {
          parentAgentId: parent.id, parentSessionId: id, parentSessionFile,
          artifactDir: join(root, id), host: hostInput,
          env: accountEnv,
          accountPolicyFile: account.selection.policyFile,
          parentAccountScope: account.selection.scope,
        };
        const first = await PaseoBackend.create(options);
        const marker = join(parentProject, `${id}.txt`);
        const record = await first.spawn({
          id, name: `Paseo ${id}`, cwd: parentProject,
          task: `Use bash to run sleep 3, then write RECONNECTED_OK to ${marker}. Reply exactly RECONNECTED_OK.`,
          model, thinking: "max", autoExit: true, interactive: false,
          sessionFile: join(root, `${id}.jsonl`), activityFile: join(root, `${id}.activity.json`),
          configDir: account.selection.credentialDir,
          extensionPath: join(PROJECT_ROOT, "pi-extension", "subagents", "index.ts"),
          env: accountEnv,
          accountPolicyFile: account.selection.policyFile,
          accountScope: account.selection.scope,
          credentialDir: account.selection.credentialDir,
        });
        childIds.push(record.agentId);
        const abandonedWatch = first.watch(record).then(
          () => "unexpected completion", (error: Error) => error.message,
        );
        await first.close();
        assert.match(await abandonedWatch, /aborted/);
        const second = await PaseoBackend.create(options);
        try {
          const restored = (await second.restore()).find((entry) => entry.id === record.id);
          assert.ok(restored);
          assert.equal(restored.agentId, record.agentId);
          const result = await second.watch(restored, AbortSignal.timeout(testTimeout));
          assert.match(result.summary, /RECONNECTED_OK/);
          await waitForFile(marker, /RECONNECTED_OK/);
          await second.ack(restored, result);
        } finally { await second.close(); }
        const third = await PaseoBackend.create(options);
        try { assert.deepEqual(await third.restore(), []); }
        finally { await third.close(); }
      },
    );
  },
);

function readFileSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
