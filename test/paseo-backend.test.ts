/**
 * Direct SDK lifecycle checks for the Paseo backend.
 *
 * The daemon client is injected so these tests exercise the request and
 * persistence protocol without needing a running Paseo daemon or provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

type Snapshot = Record<string, any>;

interface FakeDaemon extends PaseoDaemonClient {
  readonly parent: Snapshot;
  readonly child: Snapshot;
  readonly createCalls: Record<string, unknown>[];
  readonly messages: Array<{ agentId: string; text: string; options?: Record<string, unknown> }>;
  readonly cancelCalls: string[];
  connectCalls: number;
  waitCalls: number;
  disconnectNextWait: boolean;
  waitStatus: "idle" | "timeout";
}

function makeDaemon(root: string): FakeDaemon {
  const parent: Snapshot = {
    id: "parent-agent",
    provider: "pi",
    cwd: join(root, "project"),
    workspaceId: "workspace-project",
    status: "idle",
  };
  const child: Snapshot = {
    id: "native-child",
    provider: "pi",
    cwd: join(root, "project"),
    workspaceId: "workspace-project",
    status: "idle",
    persistence: { nativeHandle: join(root, "native-child.jsonl") },
  };

  const daemon: FakeDaemon = {
    parent,
    child,
    createCalls: [],
    messages: [],
    cancelCalls: [],
    connectCalls: 0,
    waitCalls: 0,
    disconnectNextWait: false,
    waitStatus: "idle",
    async connect() { this.connectCalls += 1; },
    async close() {},
    async createAgent(options) {
      this.createCalls.push(options);
      const config = (options.config ?? {}) as Record<string, unknown>;
      this.child.cwd = String(config.cwd ?? this.child.cwd);
      this.child.workspaceId = typeof options.workspaceId === "string"
        ? options.workspaceId
        : this.child.workspaceId;
      mkdirSync(root, { recursive: true });
      writeFileSync(this.child.persistence.nativeHandle, "", "utf8");
      return this.child;
    },
    async fetchAgent(agentId) {
      if (agentId === this.parent.id) return this.parent;
      if (agentId === this.child.id) return this.child;
      return null;
    },
    async sendAgentMessage(agentId, text, options) {
      this.messages.push({ agentId, text, options });
      if (text.startsWith("/pi-subagent-bootstrap ")) {
        const bootstrap = decodePaseoBootstrap(text.slice("/pi-subagent-bootstrap ".length));
        const createCall = this.createCalls.at(-1);
        const readyFile = (createCall?.env as Record<string, unknown> | undefined)?.[PASEO_BOOTSTRAP_READY_ENV];
        assert.equal(typeof readyFile, "string", "spawn must provide a bootstrap readiness path");
        mkdirSync(join(root, "artifacts", "paseo-bootstrap"), { recursive: true });
        writeFileSync(String(readyFile), `${JSON.stringify({ ok: true, requestId: bootstrap.requestId })}\n`, "utf8");
      }
    },
    async waitForFinish() {
      this.waitCalls += 1;
      if (this.disconnectNextWait) {
        this.disconnectNextWait = false;
        throw new Error("socket closed while waiting for Paseo event");
      }
      return {
        status: this.waitStatus,
        lastMessage: "native child finished",
        final: { updatedAt: Date.now() },
      } as any;
    },
    async cancelAgent(agentId) { this.cancelCalls.push(agentId); },
    async openProject(cwd) {
      return { workspace: { id: `workspace:${cwd}` } };
    },
    getConnectionState() {
      return { status: "connected" };
    },
  };
  return daemon;
}

function spawnInput(root: string, id: string, cwd = join(root, "project")) {
  const sessionFile = join(root, `${id}.jsonl`);
  writeFileSync(sessionFile, "", "utf8");
  return {
    id,
    name: `Child ${id}`,
    task: `Task ${id}`,
    cwd,
    sessionFile,
    activityFile: join(root, `${id}.activity.json`),
    model: "openai-codex/gpt-5.6-luna",
    thinking: "max",
    autoExit: true,
    interactive: false,
    bootstrap: { tools: ["read", "caller_ping"] },
  };
}

async function makeBackend(root: string, daemon: FakeDaemon, session = "parent-session") {
  return PaseoBackend.create({
    parentAgentId: daemon.parent.id,
    parentSessionId: session,
    artifactDir: join(root, "artifacts"),
    client: daemon,
  });
}

function writeSignal(record: PaseoSubagentRecord, signal: Record<string, unknown>): void {
  appendFileSync(
    `${record.sessionFile}.paseo-events.jsonl`,
    `${JSON.stringify({ id: signal.id ?? `signal-${Date.now()}`, timestamp: Date.now(), ...signal })}\n`,
    "utf8",
  );
}

test("Paseo spawn creates a native Pi child with caller lineage and cross-project workspace placement", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-backend-spawn-"));
  try {
    mkdirSync(join(root, "project"), { recursive: true });
    const daemon = makeDaemon(root);
    const backend = await makeBackend(root, daemon);

    const sameProject = await backend.spawn(spawnInput(root, "same-project", join(root, "project")));
    const sameCall = daemon.createCalls[0];
    assert.equal(sameCall.callerAgentId, "parent-agent");
    assert.equal(sameCall.provider, "pi");
    assert.equal(sameCall.workspaceId, undefined, "children inside the parent checkout reuse its workspace");
    assert.equal((sameCall.config as any).cwd, join(root, "project"));
    assert.equal((sameCall.labels as any)["pi-subagent-backend"], "paseo");
    assert.equal((sameCall.labels as any)["pi-subagent-id"], "same-project");
    assert.equal((sameCall.env as any).PI_SUBAGENT_BACKEND, "paseo");
    assert.equal(daemon.messages.length, 2, "bootstrap and task are separate native Pi messages");
    assert.match(daemon.messages[0].text, /^\/pi-subagent-bootstrap /);
    assert.equal(daemon.messages[1].text, "Task same-project");
    assert.equal(sameProject.agentId, "native-child");

    const other = join(root, "other-project");
    mkdirSync(other, { recursive: true });
    await backend.spawn(spawnInput(root, "cross-project", other));
    const crossCall = daemon.createCalls[1];
    assert.equal(crossCall.workspaceId, `workspace:${other}`);
    assert.equal((crossCall.config as any).cwd, other);
    assert.equal(crossCall.callerAgentId, "parent-agent", "placement does not change parentage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Paseo watch returns explicit success and provider failure signals with stable delivery IDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-backend-watch-"));
  try {
    mkdirSync(join(root, "project"), { recursive: true });
    const daemon = makeDaemon(root);
    const backend = await makeBackend(root, daemon);

    const success = await backend.spawn(spawnInput(root, "success"));
    writeFileSync(success.sessionFile, [
      { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Completed the requested work." }] } },
      { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted", content: [] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    writeSignal(success, { type: "done", id: "done-success", payload: {} });
    const successResult = await backend.watch(success);
    assert.equal(successResult.exitCode, 0);
    assert.equal(successResult.deliveryId, "paseo:native-child:done-success");
    assert.equal(successResult.errorMessage, undefined);
    assert.equal(successResult.summary, "Completed the requested work.", "managed done must not report the synthetic abort as its summary");

    const failure = await backend.spawn(spawnInput(root, "failure"));
    writeSignal(failure, {
      type: "error",
      id: "provider-1",
      payload: { errorMessage: "provider unavailable" },
    });
    const failureResult = await backend.watch(failure);
    assert.equal(failureResult.exitCode, 1);
    assert.equal(failureResult.deliveryId, "paseo:native-child:provider-1");
    assert.match(failureResult.errorMessage ?? "", /provider unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Paseo watcher reconnects after a transport error without cancelling the managed child", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-backend-reconnect-"));
  try {
    mkdirSync(join(root, "project"), { recursive: true });
    const daemon = makeDaemon(root);
    const backend = await makeBackend(root, daemon);
    const record = await backend.spawn(spawnInput(root, "reconnect"));
    daemon.disconnectNextWait = true;
    writeSignal(record, { type: "done", id: "done-after-reconnect", payload: {} });

    const result = await backend.watch(record);
    assert.equal(result.exitCode, 0);
    assert.equal(result.deliveryId, "paseo:native-child:done-after-reconnect");
    assert.ok(daemon.waitCalls >= 2, "the watcher retries after the disconnected wait");
    assert.deepEqual(daemon.cancelCalls, [], "disconnect recovery must never cancel the child");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Paseo restore reloads running records and ack makes delivery durable across backend instances", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-backend-restore-"));
  try {
    mkdirSync(join(root, "project"), { recursive: true });
    const daemon = makeDaemon(root);
    const first = await makeBackend(root, daemon, "original-session");
    const record = await first.spawn(spawnInput(root, "durable"));
    const restoredBackend = await makeBackend(root, daemon, "reconnected-session");
    const restored = await restoredBackend.restore();
    assert.equal(restored.length, 1);
    assert.equal(restored[0].id, record.id);
    assert.equal(restored[0].agentId, "native-child");

    const delivery = {
      name: record.name,
      task: record.task,
      summary: "done",
      sessionFile: record.sessionFile,
      exitCode: 0,
      elapsed: 1,
      deliveryId: "durable-delivery",
    };
    await restoredBackend.ack(restored[0], delivery);
    assert.deepEqual(await restoredBackend.restore(), [], "acked records are not replayed after restart");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
