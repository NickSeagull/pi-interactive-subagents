/**
 * Paseo backend orchestration tests.
 *
 * These tests stay at the extension boundary: the SDK-backed PaseoBackend is
 * replaced with a deterministic fake, while the real extension registration,
 * session placement, bootstrap payload, watcher, result delivery, and user
 * controls all run unchanged.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import subagentsExtension, { __test__ as extensionTest } from "../pi-extension/subagents/index.ts";
import { PaseoBackend } from "../pi-extension/subagents/paseo.ts";

type Handler = (...args: any[]) => unknown;

interface TestContext {
  sessionManager: {
    getSessionFile(): string;
    getSessionId(): string;
    getSessionDir(): string;
    getEntries(): any[];
  };
  cwd: string;
  hasUI: boolean;
  ui: {
    notify(message: string, level?: string): void;
    setWidget(...args: any[]): void;
  };
}

interface SpawnInput {
  id: string;
  name: string;
  task: string;
  agent?: string;
  cwd: string;
  sessionFile: string;
  activityFile: string;
  sessionMode: string;
  autoExit: boolean;
  interactive: boolean;
  configDir: string;
  extensionPath: string;
  prompt: string;
  bootstrap?: {
    sessionFile?: string;
    tools?: string[];
    deniedTools?: string[];
    systemPrompt?: string;
    systemPromptMode?: string;
    skills?: string[];
  };
  [key: string]: unknown;
}

interface PaseoRecord {
  id: string;
  agentId: string;
  name: string;
  task: string;
  agent?: string;
  cwd: string;
  sessionFile: string;
  startTime: number;
  [key: string]: unknown;
}

interface PaseoResult {
  name: string;
  task: string;
  summary: string;
  sessionFile: string;
  exitCode: number;
  elapsed: number;
  deliveryId?: string;
  errorMessage?: string;
  ping?: { name: string; message: string };
  [key: string]: unknown;
}

type Watcher = {
  resolve: (result: PaseoResult) => void;
  reject: (error: Error) => void;
};

/**
 * A tiny SDK-facing fake. It deliberately models a watcher that remains alive
 * while the WebSocket is disconnected; reconnect is represented by calling
 * complete() after disconnect(). This catches accidental kill-on-disconnect
 * behavior without requiring a daemon or a private protocol fixture.
 */
class FakePaseoBackend {
  readonly createOptions: Record<string, unknown>;
  readonly spawnCalls: SpawnInput[] = [];
  readonly watchCalls: string[] = [];
  readonly ackCalls: Array<{ record: PaseoRecord; result: PaseoResult }> = [];
  readonly resumeCalls: any[] = [];
  readonly interruptCalls: string[] = [];
  readonly killCalls: string[] = [];
  readonly closeCalls: number[] = [];
  readonly records: PaseoRecord[] = [];
  readonly restoreRecords: PaseoRecord[];
  readonly watchers = new Map<string, Watcher>();
  disconnected = false;
  private nextAgent = 1;

  constructor(options: Record<string, unknown>, restoreRecords: PaseoRecord[] = []) {
    this.createOptions = options;
    this.restoreRecords = restoreRecords;
  }

  async resolveAccountForCwd(_cwd: string) {
    return undefined;
  }

  async spawn(input: SpawnInput): Promise<PaseoRecord> {
    this.spawnCalls.push(input);
    const record: PaseoRecord = {
      id: input.id,
      agentId: `paseo-agent-${this.nextAgent++}`,
      name: input.name,
      task: input.task,
      agent: input.agent,
      cwd: input.cwd,
      sessionFile: input.sessionFile,
      startTime: Date.now(),
    };
    this.records.push(record);
    return record;
  }

  async restore(): Promise<PaseoRecord[]> {
    return [...this.restoreRecords];
  }

  watch(record: PaseoRecord, signal: AbortSignal): Promise<PaseoResult> {
    this.watchCalls.push(record.id);
    return new Promise<PaseoResult>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("watch aborted"));
        return;
      }
      this.watchers.set(record.id, { resolve, reject });
      signal.addEventListener(
        "abort",
        () => {
          this.watchers.delete(record.id);
          reject(new Error("watch aborted"));
        },
        { once: true },
      );
    });
  }

  async ack(record: PaseoRecord, result: PaseoResult): Promise<void> {
    this.ackCalls.push({ record, result });
  }

  async resume(params: { agentId?: string; message?: string }): Promise<PaseoRecord> {
    this.resumeCalls.push(params);
    const source = this.records.find((record) => record.agentId === params.agentId) ?? this.restoreRecords[0];
    if (!source) throw new Error(`No record for ${params.agentId ?? "resume"}`);
    const record: PaseoRecord = {
      ...source,
      id: `${source.id}-resume-${this.resumeCalls.length}`,
      startTime: Date.now(),
    };
    this.records.push(record);
    return record;
  }

  async interrupt(agentId: string): Promise<void> {
    this.interruptCalls.push(agentId);
  }

  async close(): Promise<void> {
    this.closeCalls.push(Date.now());
  }

  /** Simulate a transport loss without resolving or rejecting the watcher. */
  disconnect(): void {
    this.disconnected = true;
  }

  /** Deliver a daemon result after the transport has recovered. */
  complete(recordId: string, partial: Partial<PaseoResult>): void {
    const watcher = this.watchers.get(recordId);
    if (!watcher) throw new Error(`No watcher for ${recordId}`);
    const record = [...this.records, ...this.restoreRecords].find((entry) => entry.id === recordId);
    if (!record) throw new Error(`No record for ${recordId}`);
    this.watchers.delete(recordId);
    watcher.resolve({
      name: record.name,
      task: record.task,
      summary: "completed",
      sessionFile: record.sessionFile,
      exitCode: 0,
      elapsed: 1,
      ...partial,
    });
  }
}

function createPiHarness() {
  const handlers = new Map<string, Handler[]>();
  const tools: any[] = [];
  const messages: any[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  let activeEntries: any[] | undefined;
  let persistOutgoingMessages = true;

  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendMessage(message: any, options?: any) {
      messages.push({ message, options });
      // Pi appends a custom message after the message_end hook. The real
      // extension waits for that durable transcript entry before it acks the
      // Paseo delivery. Keep the default fake behavior close to Pi while
      // allowing the explicit race test below to hold persistence back.
      const deliveryId = message?.details?.paseoDeliveryId;
      if (persistOutgoingMessages && deliveryId && activeEntries) {
        activeEntries.push({ type: "custom_message", details: { paseoDeliveryId: deliveryId } });
      }
    },
    getAllTools() {
      return [];
    },
  };

  return {
    pi,
    handlers,
    tools,
    messages,
    notifications,
    get activeEntries() { return activeEntries; },
    set activeEntries(value: any[] | undefined) { activeEntries = value; },
    get persistOutgoingMessages() { return persistOutgoingMessages; },
    set persistOutgoingMessages(value: boolean) { persistOutgoingMessages = value; },
  };
}

function getTool(harness: ReturnType<typeof createPiHarness>, name: string): any {
  const tool = harness.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected ${name} to be registered`);
  return tool;
}

async function emit(
  harness: ReturnType<typeof createPiHarness>,
  event: string,
  eventPayload: any,
  context: TestContext,
): Promise<void> {
  harness.activeEntries = context.sessionManager.getEntries();
  for (const handler of harness.handlers.get(event) ?? []) {
    await handler(eventPayload, context);
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  // message_end acknowledgement intentionally runs in a zero-delay timer.
  // setImmediate alone can run first, depending on the event-loop phase.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function createContext(root: string, sessionId: string, entries: any[] = []) {
  const projectDir = join(root, "project");
  const sessionDir = join(root, "sessions");
  const parentSession = join(sessionDir, `${sessionId}.jsonl`);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    parentSession,
    `${JSON.stringify({ type: "session", id: sessionId, version: 3 })}\n`,
  );

  const context: TestContext = {
    sessionManager: {
      getSessionFile: () => parentSession,
      getSessionId: () => sessionId,
      getSessionDir: () => sessionDir,
      getEntries: () => entries,
    },
    cwd: projectDir,
    hasUI: true,
    ui: {
      notify(message: string, level?: string) {
        notificationsForContext.push({ message, level });
      },
      setWidget() {},
    },
  };
  const notificationsForContext: Array<{ message: string; level?: string }> = [];
  return { context, projectDir, parentSession, sessionDir, entries, notifications: notificationsForContext };
}

function lastMessage(harness: ReturnType<typeof createPiHarness>): any {
  const last = harness.messages.at(-1);
  assert.ok(last, "Expected a parent message");
  return last.message;
}

function persistDelivery(entries: any[], deliveryId: string): void {
  entries.push({
    type: "custom_message",
    details: { paseoDeliveryId: deliveryId },
  });
}

describe("Paseo-backed subagent orchestration", () => {
  const previousAgentId = process.env.PASEO_AGENT_ID;
  const previousBackend = process.env.PI_SUBAGENT_BACKEND;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let root = "";
  let harness: ReturnType<typeof createPiHarness>;
  let backends: FakePaseoBackend[];
  let currentBackend: FakePaseoBackend;
  let originalCreate: any;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "paseo-orchestration-"));
    const agentDir = join(root, "agent-config");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    process.env.PASEO_AGENT_ID = "parent-agent-001";
    delete process.env.PI_SUBAGENT_BACKEND;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    harness = createPiHarness();
    subagentsExtension(harness.pi as any);
    backends = [];
    originalCreate = (PaseoBackend as any).create;
    (PaseoBackend as any).create = async (options: Record<string, unknown>) => {
      currentBackend = new FakePaseoBackend(options);
      backends.push(currentBackend);
      return currentBackend;
    };
  });

  after(async () => {
    // Shutdown clears the extension's intervals and aborts its watcher signal.
    const shutdown = createContext(root, "shutdown");
    await emit(harness, "session_shutdown", { reason: "test" }, shutdown.context);
    (PaseoBackend as any).create = originalCreate;
    extensionTest.runningSubagents.clear();
    rmSync(root, { recursive: true, force: true });
    if (previousAgentId === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previousAgentId;
    if (previousBackend === undefined) delete process.env.PI_SUBAGENT_BACKEND;
    else process.env.PI_SUBAGENT_BACKEND = previousBackend;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  afterEach(() => {
    extensionTest.runningSubagents.clear();
  });

  it("creates native children with parent lineage, bootstrap data, and exact checkout placement", async () => {
    const session = createContext(root, "placement-and-bootstrap");
    await emit(harness, "session_start", {}, session.context);
    const backend = currentBackend;
    const subagent = getTool(harness, "subagent");
    const crossProject = join(root, "other-project");
    mkdirSync(crossProject, { recursive: true });

    const started = await subagent.execute(
      "tool-placement",
      {
        name: "Native child",
        task: "Inspect the other checkout",
        cwd: crossProject,
        fork: true,
        tools: "read,write",
        skills: "planning,review",
        systemPrompt: "You are the checkout investigator.",
      },
      new AbortController().signal,
      undefined,
      session.context,
    );

    assert.equal(started.details.status, "started");
    assert.equal(backend.createOptions.parentAgentId, "parent-agent-001");
    assert.equal(backend.createOptions.parentSessionId, "placement-and-bootstrap");
    assert.match(String(backend.createOptions.artifactDir), /placement-and-bootstrap/);
    assert.equal(backend.spawnCalls.length, 1);

    const input = backend.spawnCalls[0];
    assert.equal(input.cwd, crossProject, "a cross-project child uses the requested checkout");
    assert.equal(input.sessionMode, "fork");
    assert.equal(input.bootstrap?.sessionFile, input.sessionFile, "fork bootstrap points at the seeded child session");
    assert.deepEqual(input.bootstrap?.skills, ["planning", "review"]);
    assert.deepEqual(input.bootstrap?.tools, ["read", "write", "caller_ping", "subagent_done"]);
    assert.match(input.extensionPath, /pi-extension[\\/]subagents[\\/]index\.ts$/);
    assert.ok(readFileSync(input.sessionFile, "utf8").includes("placement-and-bootstrap"));

    backend.complete(input.id, { summary: "Read the other checkout.", deliveryId: "placement-1" });
    await flush();
    const result = lastMessage(harness);
    assert.equal(result.customType, "subagent_result");
    assert.equal(result.details.paseoAgentId, started.details.paseoAgentId);
    assert.equal(result.details.paseoDeliveryId, "placement-1");
    assert.match(result.content, /completed/);
    assert.equal(backend.ackCalls.length, 1);
  });

  it("distinguishes successful completion from provider failure", async () => {
    const session = createContext(root, "success-and-failure");
    await emit(harness, "session_start", {}, session.context);
    const backend = currentBackend;
    const subagent = getTool(harness, "subagent");

    const success = await subagent.execute(
      "tool-success",
      { name: "Successful child", task: "Return a result" },
      new AbortController().signal,
      undefined,
      session.context,
    );
    const successInput = backend.spawnCalls[0];
    backend.complete(successInput.id, {
      summary: "The work is complete.",
      deliveryId: "success-1",
      exitCode: 0,
    });
    await flush();
    assert.match(lastMessage(harness).content, /completed/);
    assert.equal(lastMessage(harness).details.paseoAgentId, success.details.paseoAgentId);

    const failure = await subagent.execute(
      "tool-failure",
      { name: "Failed child", task: "Hit a provider error" },
      new AbortController().signal,
      undefined,
      session.context,
    );
    const failureInput = backend.spawnCalls[1];
    backend.complete(failureInput.id, {
      summary: "No usable output.",
      deliveryId: "failure-1",
      exitCode: 1,
      errorMessage: "provider unavailable",
    });
    await flush();
    const failureMessage = lastMessage(harness);
    assert.equal(failureMessage.customType, "subagent_result");
    assert.match(failureMessage.content, /failed after/);
    assert.match(failureMessage.content, /provider unavailable/);
    assert.equal(failureMessage.details.errorMessage, "provider unavailable");
    assert.equal(failure.details.status, "started");
  });

  it("keeps help, interrupt, and resume under direct Paseo control", async () => {
    const session = createContext(root, "controls");
    await emit(harness, "session_start", {}, session.context);
    const backend = currentBackend;
    const subagent = getTool(harness, "subagent");
    const interrupt = getTool(harness, "subagent_interrupt");
    const resume = getTool(harness, "subagent_resume");

    await subagent.execute(
      "tool-help",
      { name: "Needs help", task: "Ask the parent a question", interactive: true },
      new AbortController().signal,
      undefined,
      session.context,
    );
    const input = backend.spawnCalls[0];
    const record = backend.records[0];
    const interruptResult = await interrupt.execute(
      "interrupt-help",
      { id: input.id },
      new AbortController().signal,
      undefined,
      session.context,
    );
    assert.equal(interruptResult.details.status, "interrupt_requested");
    assert.deepEqual(backend.interruptCalls, [record.agentId]);

    backend.complete(input.id, {
      ping: { name: "Needs help", message: "Which schema should I use?" },
      deliveryId: "help-1",
    });
    await flush();
    const helpMessage = lastMessage(harness);
    assert.equal(helpMessage.customType, "subagent_ping");
    assert.match(helpMessage.content, /Which schema should I use/);
    assert.equal(backend.ackCalls.length, 1);

    const resumed = await resume.execute(
      "resume-help",
      { agentId: record.agentId, message: "Use the v2 schema.", autoExit: false },
      new AbortController().signal,
      undefined,
      session.context,
    );
    assert.equal(resumed.details.status, "started");
    assert.equal(backend.resumeCalls[0].agentId, record.agentId);
    assert.equal(backend.resumeCalls[0].message, "Use the v2 schema.");
    const resumedRecord = backend.records.at(-1)!;
    backend.complete(resumedRecord.id, {
      summary: "Resumed with the v2 schema.",
      deliveryId: "resume-1",
    });
    await flush();
    assert.match(lastMessage(harness).content, /Resumed with the v2 schema/);
  });

  it("survives disconnects and suppresses duplicate delivery after restore", async () => {
    const entries: any[] = [];
    const session = createContext(root, "durable-reconnect", entries);
    await emit(harness, "session_start", {}, session.context);
    const firstBackend = currentBackend;
    const subagent = getTool(harness, "subagent");

    await subagent.execute(
      "tool-reconnect",
      { name: "Durable child", task: "Continue through a reconnect" },
      new AbortController().signal,
      undefined,
      session.context,
    );
    const input = firstBackend.spawnCalls[0];
    const messagesBeforeDisconnect = harness.messages.length;
    firstBackend.disconnect();
    await flush();
    assert.equal(firstBackend.disconnected, true);
    assert.equal(firstBackend.killCalls.length, 0, "disconnect must not kill the managed child");
    assert.equal(
      harness.messages.length,
      messagesBeforeDisconnect,
      "disconnect emits no synthetic completion",
    );

    firstBackend.complete(input.id, {
      summary: "Completed after reconnect.",
      deliveryId: "durable-delivery-1",
    });
    await flush();
    const delivered = lastMessage(harness);
    assert.equal(delivered.customType, "subagent_result");
    assert.equal(delivered.details.paseoDeliveryId, "durable-delivery-1");
    // A fresh extension session restores the still-managed record. The daemon
    // may replay its terminal event, so the parent transcript is the durable
    // idempotency boundary.
    const restoredRecord: PaseoRecord = {
      ...backendRecordFromInput(firstBackend, input),
    };
    const restoredBackend = new FakePaseoBackend(
      { parentAgentId: "parent-agent-001", parentSessionId: "durable-reconnect-restart" },
      [restoredRecord],
    );
    backends.push(restoredBackend);
    currentBackend = restoredBackend;
    const oldCreate = (PaseoBackend as any).create;
    (PaseoBackend as any).create = async () => restoredBackend;
    const restarted = createContext(root, "durable-reconnect-restart", entries);
    await emit(harness, "session_start", {}, restarted.context);
    await flush();
    assert.deepEqual(restoredBackend.watchCalls, [restoredRecord.id]);
    restoredBackend.complete(restoredRecord.id, {
      summary: "The same terminal event replayed.",
      deliveryId: "durable-delivery-1",
    });
    await flush();
    assert.equal(lastMessage(harness), delivered, "duplicate delivery ID must not wake the parent twice");
    assert.equal(restoredBackend.ackCalls.length, 1, "replayed events are still acknowledged");
    assert.equal(restoredBackend.killCalls.length, 0);
    (PaseoBackend as any).create = oldCreate;
  });

  it("waits for Pi to persist a queued notification before acknowledging it", async () => {
    const entries: any[] = [];
    const session = createContext(root, "ack-after-persist", entries);
    await emit(harness, "session_start", {}, session.context);
    const backend = currentBackend;
    const subagent = getTool(harness, "subagent");
    harness.persistOutgoingMessages = false;

    await subagent.execute(
      "tool-ack-race",
      { name: "Ack race", task: "Return a result" },
      new AbortController().signal,
      undefined,
      session.context,
    );
    const input = backend.spawnCalls[0];
    backend.complete(input.id, { summary: "Queued result", deliveryId: "ack-race-1" });
    await flush();
    assert.equal(backend.ackCalls.length, 0, "the SDK result is still unacknowledged before Pi persistence");

    await emit(harness, "message_end", {}, session.context);
    await flush();
    assert.equal(backend.ackCalls.length, 0, "message_end alone cannot prove persistence");

    persistDelivery(entries, "ack-race-1");
    await emit(harness, "message_end", {}, session.context);
    await flush();
    assert.equal(backend.ackCalls.length, 1, "the durable transcript entry releases the SDK acknowledgement");
    harness.persistOutgoingMessages = true;
  });
});

function backendRecordFromInput(backend: FakePaseoBackend, input: SpawnInput): PaseoRecord {
  const record = backend.records.find((candidate) => candidate.id === input.id);
  assert.ok(record, `Expected fake record for ${input.id}`);
  return record;
}
