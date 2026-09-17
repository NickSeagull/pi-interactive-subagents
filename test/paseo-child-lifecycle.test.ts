/** Tests for the managed-child half of the Paseo lifecycle. */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";

function createApi() {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const tools: any[] = [];
  const api = {
    on(event: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerShortcut() {},
    getAllTools() {
      return [];
    },
  };
  return { api, handlers, tools };
}

describe("Paseo-managed child lifecycle", () => {
  const oldValues: Record<string, string | undefined> = {};
  let root = "";

  before(() => {
    root = mkdtempSync(join(tmpdir(), "paseo-child-"));
    for (const name of [
      "PI_SUBAGENT_BACKEND",
      "PI_SUBAGENT_SESSION",
      "PI_SUBAGENT_ID",
      "PI_SUBAGENT_NAME",
      "PI_SUBAGENT_ACTIVITY_FILE",
    ]) {
      oldValues[name] = process.env[name];
    }
    process.env.PI_SUBAGENT_BACKEND = "paseo";
    process.env.PI_SUBAGENT_SESSION = join(root, "child.jsonl");
    process.env.PI_SUBAGENT_ID = "child-paseo-1";
    process.env.PI_SUBAGENT_NAME = "Paseo child";
    process.env.PI_SUBAGENT_ACTIVITY_FILE = join(root, "child.activity.json");
  });

  after(() => {
    for (const [name, value] of Object.entries(oldValues)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("signals completion and help while keeping the Paseo process alive", async () => {
    const { api, handlers, tools } = createApi();
    subagentDoneExtension(api as any);
    const context = {
      abortCalls: 0,
      shutdownCalls: 0,
      abort() {
        this.abortCalls++;
      },
      shutdown() {
        this.shutdownCalls++;
      },
    };
    const done = tools.find((tool) => tool.name === "subagent_done");
    const ping = tools.find((tool) => tool.name === "caller_ping");
    assert.ok(done);
    assert.ok(ping);

    const doneResult = await done.execute(
      "done-call",
      {},
      new AbortController().signal,
      undefined,
      context,
    );
    assert.match(doneResult.content[0].text, /managed session will remain idle/i);
    assert.equal(context.abortCalls, 0, "managed completion must finish with a normal Pi stop reason");
    assert.equal(context.shutdownCalls, 0, "Paseo owns process lifetime");
    assert.deepEqual(
      JSON.parse(readFileSync(`${process.env.PI_SUBAGENT_SESSION}.exit`, "utf8")),
      { type: "done" },
    );

    // A later user turn resets the managed recorder and can request help from
    // the same process. The old completion sidecar is replaced by the ping.
    for (const handler of handlers.get("input") ?? []) await handler({}, context);
    const pingResult = await ping.execute(
      "ping-call",
      { message: "I need the parent to choose a schema." },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.match(pingResult.content[0].text, /managed session will remain idle/i);
    assert.equal(context.abortCalls, 0, "managed help must finish with a normal Pi stop reason");
    assert.equal(context.shutdownCalls, 0);
    assert.deepEqual(
      JSON.parse(readFileSync(`${process.env.PI_SUBAGENT_SESSION}.exit`, "utf8")),
      {
        type: "ping",
        name: "Paseo child",
        message: "I need the parent to choose a schema.",
      },
    );
  });

  it("retains terminal subagent shutdown behavior outside Paseo", async () => {
    delete process.env.PI_SUBAGENT_BACKEND;
    const { api, tools } = createApi();
    subagentDoneExtension(api as any);
    const context = {
      abortCalls: 0,
      shutdownCalls: 0,
      abort() {
        this.abortCalls++;
      },
      shutdown() {
        this.shutdownCalls++;
      },
    };
    const done = tools.find((tool) => tool.name === "subagent_done");
    assert.ok(done);
    const result = await done.execute(
      "terminal-done",
      {},
      new AbortController().signal,
      undefined,
      context,
    );
    assert.match(result.content[0].text, /shutting down/i);
    assert.equal(context.abortCalls, 0);
    assert.equal(context.shutdownCalls, 1);
    process.env.PI_SUBAGENT_BACKEND = "paseo";
  });
});
