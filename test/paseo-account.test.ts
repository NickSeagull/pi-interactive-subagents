/**
 * Account routing checks for the Paseo backend.
 *
 * The daemon is a structural fake, while both account profiles contain only
 * synthetic OAuth-shaped fixture data. No existing credential file is read by
 * this test; the production preflight reads the temporary fixture through Pi's
 * AuthStorage API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PaseoBackend,
  type PaseoDaemonClient,
  type PaseoSubagentRecord,
} from "../pi-extension/subagents/paseo.ts";
import {
  PASEO_BOOTSTRAP_READY_ENV,
  decodePaseoBootstrap,
} from "../pi-extension/subagents/paseo-bootstrap.ts";
import { canonicalPath } from "../pi-extension/subagents/account-scope.mjs";
import { createAccountSessionEntry } from "../pi-extension/subagents/account-session.mjs";

type Snapshot = Record<string, any>;

interface FakeDaemon extends PaseoDaemonClient {
  readonly parent: Snapshot;
  readonly children: Map<string, Snapshot>;
  readonly createCalls: Record<string, any>[];
  readonly messages: Array<{ agentId: string; text: string; options?: Record<string, unknown> }>;
}

function makeFixture(root: string): {
  policyFile: string;
  personalDir: string;
  companyDir: string;
  companyProject: string;
  openSourceProject: string;
} {
  const personalDir = join(root, "personal-profile");
  const companyDir = join(root, "company-profile");
  const companyProject = join(root, "company-project");
  const openSourceProject = join(root, "open-source-project");
  for (const directory of [personalDir, companyDir, companyProject, openSourceProject]) {
    mkdirSync(directory, { recursive: true });
  }

  // These values are intentionally synthetic and are never used for a model
  // request. AuthStorage only needs an OAuth-shaped record for preflight.
  const auth = JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "synthetic-access-token",
      refresh: "synthetic-refresh-token",
      expires: Date.now() + 3_600_000,
    },
  });
  writeFileSync(join(personalDir, "auth.json"), auth, "utf8");
  writeFileSync(join(companyDir, "auth.json"), auth, "utf8");

  const policyFile = join(root, "account-policy.json");
  writeFileSync(policyFile, `${JSON.stringify({
    personalAgentDir: personalDir,
    companyAgentDir: companyDir,
    companyRoots: [companyProject],
  })}\n`, "utf8");
  return { policyFile, personalDir, companyDir, companyProject, openSourceProject };
}

function makeDaemon(root: string, parentProvider: "pi" | "pi-personal" | "pi-company" = "pi"): FakeDaemon {
  const parent: Snapshot = {
    id: "parent-agent",
    provider: parentProvider,
    cwd: join(root, "open-source-project"),
    workspaceId: "workspace-parent",
    status: "idle",
  };
  const daemon: FakeDaemon = {
    parent,
    children: new Map(),
    createCalls: [],
    messages: [],
    async connect() {},
    async close() {},
    async createAgent(options) {
      daemon.createCalls.push(options);
      const id = `native-child-${daemon.createCalls.length}`;
      const native = join(root, `${id}.jsonl`);
      writeFileSync(native, "", "utf8");
      const snapshot: Snapshot = {
        id,
        provider: options.provider,
        cwd: options.cwd,
        workspaceId: options.workspaceId ?? "workspace-parent",
        status: "idle",
        persistence: { nativeHandle: native },
        labels: options.labels,
      };
      daemon.children.set(id, snapshot);
      return snapshot;
    },
    async fetchAgent(agentId) {
      if (agentId === parent.id) return parent;
      return daemon.children.get(agentId) ?? null;
    },
    async sendAgentMessage(agentId, text, options) {
      daemon.messages.push({ agentId, text, options });
      if (!text.startsWith("/pi-subagent-bootstrap ")) return;
      const config = decodePaseoBootstrap(text.slice("/pi-subagent-bootstrap ".length));
      const call = daemon.createCalls.at(-1);
      const readyFile = call?.env?.[PASEO_BOOTSTRAP_READY_ENV];
      assert.equal(typeof readyFile, "string");
      mkdirSync(join(root, "artifacts", "paseo-bootstrap"), { recursive: true });
      writeFileSync(String(readyFile), `${JSON.stringify({ ok: true, requestId: config.requestId })}\n`, "utf8");
    },
    async waitForFinish() {
      return { status: "idle", lastMessage: "synthetic child finished", final: { updatedAt: Date.now() } } as any;
    },
    async cancelAgent() {},
    async openProject(cwd) {
      return { workspace: { id: `workspace:${cwd}` } };
    },
    getConnectionState() {
      return { status: "connected" };
    },
  };
  return daemon;
}

function spawnInput(root: string, id: string, cwd: string) {
  const sessionFile = join(root, `${id}.jsonl`);
  writeFileSync(sessionFile, "", "utf8");
  return {
    id,
    name: `Child ${id}`,
    task: `Task ${id}`,
    cwd,
    sessionFile,
    activityFile: join(root, `${id}.activity.json`),
    autoExit: true,
    interactive: false,
    bootstrap: { tools: ["read"] },
  };
}

async function makeBackend(root: string, policyFile: string, daemon: FakeDaemon, parentAccountScope?: string) {
  return PaseoBackend.create({
    parentAgentId: daemon.parent.id,
    parentSessionId: "parent-session",
    artifactDir: join(root, "artifacts"),
    client: daemon,
    accountPolicyFile: policyFile,
    parentAccountScope,
    // Keep this test independent of any ambient developer launcher markers.
    env: { PI_ACCOUNT_POLICY_FILE: policyFile },
  });
}

test("Paseo selects explicit personal/company providers and per-agent credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-account-routing-"));
  try {
    const fixture = makeFixture(root);
    const daemon = makeDaemon(root, "pi");
    const backend = await makeBackend(root, fixture.policyFile, daemon);

    assert.equal((await backend.resolveAccountForCwd(fixture.openSourceProject))?.scope, "personal");
    assert.equal((await backend.resolveAccountForCwd(fixture.companyProject))?.scope, "company");

    const personal = await backend.spawn(spawnInput(root, "personal", fixture.openSourceProject));
    const personalCall = daemon.createCalls[0];
    assert.equal(personalCall.provider, "pi-personal");
    assert.equal(personalCall.env.PI_CODING_AGENT_DIR, canonicalPath(fixture.personalDir));
    assert.equal(personalCall.env.PI_ACCOUNT_SCOPE, "personal");
    assert.equal(personalCall.env.PI_ACCOUNT_PROVIDER_SCOPE, "personal");
    assert.equal(personalCall.labels["pi-account-scope"], "personal");
    assert.equal(personal.provider, "pi-personal");

    const company = await backend.spawn(spawnInput(root, "company", fixture.companyProject));
    const companyCall = daemon.createCalls[1];
    assert.equal(companyCall.provider, "pi-company");
    assert.equal(companyCall.env.PI_CODING_AGENT_DIR, canonicalPath(fixture.companyDir));
    assert.equal(companyCall.env.PI_ACCOUNT_SCOPE, "company");
    assert.equal(companyCall.labels["pi-account-provider"], "pi-company");
    assert.equal(company.accountScope, "company");
    assert.equal(company.credentialDir, canonicalPath(fixture.companyDir));
    assert.equal(company.provider, "pi-company");
    await backend.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Paseo keeps company parent and persisted company children sticky outside roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-account-sticky-"));
  try {
    const fixture = makeFixture(root);
    const daemon = makeDaemon(root, "pi-company");
    const backend = await makeBackend(root, fixture.policyFile, daemon, "company");
    const record = await backend.spawn(spawnInput(root, "company-child", fixture.openSourceProject));
    assert.equal(record.accountScope, "company");
    assert.equal(record.provider, "pi-company");

    const beforeResume = daemon.messages.length;
    const resumed = await backend.resume({ agentId: record.agentId, message: "Continue the synthetic task." });
    assert.equal(resumed.agentId, record.agentId, "resume keeps the same Paseo agent");
    assert.equal(resumed.accountScope, "company");
    assert.equal(resumed.provider, "pi-company");
    assert.equal(daemon.createCalls.length, 1, "normal company resume does not recreate the native agent");
    assert.equal(daemon.messages.length, beforeResume + 2, "resume sends bootstrap and the follow-up through Paseo");
    await backend.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Paseo honors company metadata already present in a seeded session", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-account-seeded-"));
  try {
    const fixture = makeFixture(root);
    const daemon = makeDaemon(root, "pi-personal");
    const backend = await makeBackend(root, fixture.policyFile, daemon, "personal");
    const seeded = join(root, "seeded.jsonl");
    writeFileSync(seeded, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "seeded-session",
      cwd: fixture.openSourceProject,
    })}\n`, "utf8");
    const metadata = {
      scope: "company" as const,
      cwd: fixture.openSourceProject,
      credentialDir: fixture.companyDir,
      policyFile: fixture.policyFile,
    };
    writeFileSync(seeded, `${readFileSync(seeded, "utf8")}${JSON.stringify(createAccountSessionEntry(metadata))}\n`, "utf8");
    const input = spawnInput(root, "seeded-company", fixture.openSourceProject);
    input.bootstrap.sessionFile = seeded;
    const record = await backend.spawn(input);
    assert.equal(record.accountScope, "company");
    assert.equal(record.provider, "pi-company");
    assert.equal(daemon.createCalls[0].provider, "pi-company");
    await backend.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Paseo promotes a fresh seeded personal parent to company by child session cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-account-seeded-promotion-"));
  try {
    const fixture = makeFixture(root);
    const daemon = makeDaemon(root, "pi-personal");
    const backend = await makeBackend(root, fixture.policyFile, daemon, "personal");
    const seeded = join(root, "seeded-personal.jsonl");
    writeFileSync(seeded, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "seeded-personal-session",
      cwd: fixture.companyProject,
    })}\n`, "utf8");
    writeFileSync(seeded, `${readFileSync(seeded, "utf8")}${JSON.stringify(createAccountSessionEntry({
      scope: "personal" as const,
      cwd: fixture.companyProject,
      credentialDir: fixture.personalDir,
      policyFile: fixture.policyFile,
    }))}\n`, "utf8");

    const input = spawnInput(root, "promoted-company", fixture.companyProject);
    input.bootstrap.sessionFile = seeded;
    const record = await backend.spawn(input);
    assert.equal(record.accountScope, "company");
    assert.equal(record.credentialDir, canonicalPath(fixture.companyDir));
    assert.equal(record.provider, "pi-company");
    assert.equal(daemon.createCalls[0].provider, "pi-company");
    assert.equal(daemon.createCalls[0].env.PI_CODING_AGENT_DIR, canonicalPath(fixture.companyDir));
    await backend.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Paseo rejects a personal runtime promoted to company before sending resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-account-promotion-"));
  try {
    const fixture = makeFixture(root);
    const daemon = makeDaemon(root, "pi-personal");
    const first = await makeBackend(root, fixture.policyFile, daemon, "personal");
    const original = await first.spawn(spawnInput(root, "promote", fixture.openSourceProject));
    await first.close();

    // Simulate a restored record whose session cwd is now company-scoped. This
    // edits only the Paseo bookkeeping JSON, never a credential file.
    const storeFile = join(root, "artifacts", "paseo-subagents.json");
    const store = JSON.parse(readFileSync(storeFile, "utf8"));
    store.records[original.id].cwd = fixture.companyProject;
    writeFileSync(storeFile, `${JSON.stringify(store)}\n`, "utf8");

    const second = await makeBackend(root, fixture.policyFile, daemon, "personal");
    const messagesBefore = daemon.messages.length;
    await assert.rejects(
      second.resume({ agentId: original.agentId, message: "Must not be sent" }),
      /persisted personal account cannot switch to company in place/,
    );
    assert.equal(daemon.messages.length, messagesBefore, "account mismatch fails before bootstrap/task messages");
    await second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Paseo fails closed when company auth is unavailable and ignores daemon ambient profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-account-missing-"));
  try {
    const fixture = makeFixture(root);
    unlinkSync(join(fixture.companyDir, "auth.json"));
    const daemon = makeDaemon(root, "pi");
    const backend = await PaseoBackend.create({
      parentAgentId: daemon.parent.id,
      parentSessionId: "parent-session",
      artifactDir: join(root, "artifacts"),
      client: daemon,
      accountPolicyFile: fixture.policyFile,
      env: {
        PI_ACCOUNT_POLICY_FILE: fixture.policyFile,
        // A daemon with this ambient directory must still receive the
        // explicit company profile in createAgent.env.
        PI_CODING_AGENT_DIR: fixture.personalDir,
      },
    });
    await assert.rejects(
      backend.spawn(spawnInput(root, "missing-company", fixture.companyProject)),
      /company account profile is unavailable|independent openai-codex OAuth/,
    );
    assert.equal(daemon.createCalls.length, 0, "missing company auth is rejected before native creation");
    await backend.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
