import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PASEO_BOOTSTRAP_COMMAND,
  PASEO_BOOTSTRAP_ENV,
  applyPaseoBootstrap,
  decodePaseoBootstrap,
  encodePaseoBootstrap,
  normalizePaseoBootstrap,
  registerPaseoBootstrap,
} from "../pi-extension/subagents/paseo-bootstrap.ts";

describe("Paseo Pi bootstrap", () => {
  const previousBackend = process.env.PI_SUBAGENT_BACKEND;
  const previousBootstrap = process.env[PASEO_BOOTSTRAP_ENV];
  let root = "";

  before(() => {
    root = mkdtempSync(join(tmpdir(), "paseo-bootstrap-"));
    process.env.PI_SUBAGENT_BACKEND = "paseo";
  });

  after(() => {
    if (previousBackend === undefined) delete process.env.PI_SUBAGENT_BACKEND;
    else process.env.PI_SUBAGENT_BACKEND = previousBackend;
    if (previousBootstrap === undefined) delete process.env[PASEO_BOOTSTRAP_ENV];
    else process.env[PASEO_BOOTSTRAP_ENV] = previousBootstrap;
    rmSync(root, { recursive: true, force: true });
  });

  it("normalizes flat and legacy bootstrap payloads and round-trips the wire form", () => {
    const flat = normalizePaseoBootstrap({
      version: 1,
      sessionFile: "/tmp/child.jsonl",
      tools: "read, bash, caller_ping",
      deniedTools: ["bash"],
      skills: ["/skill:planning", "review"],
      model: "openai-codex/gpt-5.6-luna",
      thinkingLevel: "max",
      name: "Native child",
      childId: "child-1",
    });
    assert.deepEqual(flat, {
      version: 1,
      sessionFile: "/tmp/child.jsonl",
      tools: ["read", "bash", "caller_ping"],
      deniedTools: ["bash"],
      skills: ["planning", "review"],
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      thinkingLevel: "max",
      name: "Native child",
      childId: "child-1",
    });

    const legacy = normalizePaseoBootstrap({
      restrictions: { tools: ["read"], denyTools: "write", skills: "planning" },
      identity: { name: "Legacy child", systemPrompt: "Role", systemPromptMode: "append" },
      session: { path: "/tmp/legacy.jsonl" },
      activity: { id: "legacy-1", file: "/tmp/activity.json" },
    });
    assert.deepEqual(legacy, {
      version: 1,
      sessionFile: "/tmp/legacy.jsonl",
      tools: ["read"],
      deniedTools: ["write"],
      systemPrompt: "Role",
      systemPromptMode: "append",
      skills: ["planning"],
      name: "Legacy child",
      childId: "legacy-1",
      activityFile: "/tmp/activity.json",
    });

    assert.deepEqual(decodePaseoBootstrap(encodePaseoBootstrap(flat)), flat);
    assert.throws(() => decodePaseoBootstrap(JSON.stringify({ version: 99 })), /Unsupported/);
  });

  it("applies tool policy, model, thinking level, and session name to the fresh Pi runtime", async () => {
    const calls: any[] = [];
    const pi = {
      getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "caller_ping" }],
      setActiveTools: (tools: string[]) => calls.push(["tools", tools]),
      setModel: async (model: unknown) => calls.push(["model", model]),
      setThinkingLevel: (level: string) => calls.push(["thinking", level]),
      setSessionName: (name: string) => calls.push(["name", name]),
    };
    const model = { provider: "openai-codex", id: "gpt-5.6-luna" };
    await applyPaseoBootstrap(
      pi as any,
      {
        modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      } as any,
      {
        version: 1,
        tools: ["read", "bash", "caller_ping"],
        deniedTools: ["bash"],
        model,
        thinkingLevel: "max",
        name: "Native child",
      },
    );
    assert.deepEqual(calls, [
      ["tools", ["read", "caller_ping"]],
      ["model", model],
      ["thinking", "max"],
      ["name", "Native child"],
    ]);
  });

  it("rejects account bootstrap mismatches before applying any runtime settings", async () => {
    const names = ["PI_ACCOUNT_LAUNCHER", "PI_ACCOUNT_SCOPE", "PI_CODING_AGENT_DIR", "PI_ACCOUNT_POLICY_FILE"];
    const saved = names.map((name) => process.env[name]);
    const config = normalizePaseoBootstrap({
      version: 1, accountScope: "company", providerScope: "company",
      credentialDir: join(root, "company"), accountPolicyFile: join(root, "policy.json"),
    });
    assert.deepEqual(decodePaseoBootstrap(encodePaseoBootstrap(config)), config);
    assert.throws(() => normalizePaseoBootstrap({ accountScope: "unknown" }), /scope/i);
    try {
      process.env.PI_ACCOUNT_LAUNCHER = "1";
      process.env.PI_ACCOUNT_SCOPE = "personal";
      process.env.PI_CODING_AGENT_DIR = config.credentialDir;
      process.env.PI_ACCOUNT_POLICY_FILE = config.accountPolicyFile;
      await assert.rejects(applyPaseoBootstrap({} as any, {} as any, config), /preflighted|relaunch/i);
      process.env.PI_ACCOUNT_SCOPE = "company";
      await applyPaseoBootstrap({} as any, {} as any, config);
      process.env.PI_CODING_AGENT_DIR = join(root, "personal");
      await assert.rejects(applyPaseoBootstrap({} as any, {} as any, config), /preflighted|relaunch/i);
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
    }
  });

  it("registers the internal command and switches to the seeded child session", async () => {
    const commands = new Map<string, any>();
    const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
    const api = {
      on(event: string, handler: (...args: any[]) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerCommand(name: string, command: any) {
        commands.set(name, command);
      },
    };
    registerPaseoBootstrap(api as any);
    assert.ok(commands.has(PASEO_BOOTSTRAP_COMMAND));

    const target = join(root, "seeded-child.jsonl");
    let switchArgs: any;
    const context = {
      sessionManager: { getSessionFile: () => join(root, "empty.jsonl") },
      switchSession: async (path: string, options: any) => {
        switchArgs = { path, options };
        await options.withSession({});
        return {};
      },
    };
    const config = { version: 1 as const, sessionFile: target, name: "Seeded child" };
    await commands.get(PASEO_BOOTSTRAP_COMMAND).handler(encodePaseoBootstrap(config), context);
    assert.equal(switchArgs.path, target);
    assert.equal(switchArgs.options.withSession instanceof Function, true);
    assert.deepEqual(decodePaseoBootstrap(process.env[PASEO_BOOTSTRAP_ENV]!), config);
  });

  it("leaves seeded-session model and thinking settings authoritative when unspecified", async () => {
    const names = [
      PASEO_BOOTSTRAP_ENV,
      "PI_SUBAGENT_BOOTSTRAP_READY",
      "PI_SUBAGENT_BOOTSTRAP_REQUEST_ID",
      "PI_SUBAGENT_SESSION",
      "PI_SUBAGENT_MODEL",
      "PI_SUBAGENT_MODEL_PROVIDER",
      "PI_SUBAGENT_MODEL_ID",
      "PI_SUBAGENT_THINKING",
    ];
    const saved = new Map(names.map((name) => [name, process.env[name]]));
    try {
      const target = join(root, "seeded-model-child.jsonl");
      process.env[PASEO_BOOTSTRAP_ENV] = encodePaseoBootstrap({
        version: 1,
        requestId: "seeded-model-1",
        sessionFile: target,
      });
      for (const name of names.slice(1)) delete process.env[name];

      const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
      const api = {
        on(event: string, handler: (...args: any[]) => unknown) {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        },
        registerCommand() {},
      };
      registerPaseoBootstrap(api as any);
      await handlers.get("session_start")?.[0]?.({}, {
        model: { provider: "launcher", id: "wrong-model" },
        thinkingLevel: "low",
        sessionManager: { getSessionFile: () => join(root, "empty.jsonl") },
      });

      assert.equal(process.env.PI_SUBAGENT_MODEL, undefined);
      assert.equal(process.env.PI_SUBAGENT_MODEL_PROVIDER, undefined);
      assert.equal(process.env.PI_SUBAGENT_MODEL_ID, undefined);
      assert.equal(process.env.PI_SUBAGENT_THINKING, undefined);
    } finally {
      for (const name of names) {
        const value = saved.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("reports malformed bootstrap environment through the readiness artifact", async () => {
    const names = [
      PASEO_BOOTSTRAP_ENV,
      "PI_SUBAGENT_BOOTSTRAP_READY",
      "PI_SUBAGENT_BOOTSTRAP_REQUEST_ID",
      "PI_SUBAGENT_SESSION",
    ];
    const saved = new Map(names.map((name) => [name, process.env[name]]));
    try {
      const target = join(root, "malformed-child.jsonl");
      const readyPath = join(root, "malformed-ready.json");
      process.env[PASEO_BOOTSTRAP_ENV] = "%%%malformed-bootstrap%%%";
      process.env.PI_SUBAGENT_BOOTSTRAP_READY = readyPath;
      process.env.PI_SUBAGENT_BOOTSTRAP_REQUEST_ID = "malformed-1";
      process.env.PI_SUBAGENT_SESSION = target;

      const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
      const api = {
        on(event: string, handler: (...args: any[]) => unknown) {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        },
        registerCommand() {},
      };
      registerPaseoBootstrap(api as any);
      const sessionStart = handlers.get("session_start")?.[0];
      assert.ok(sessionStart);
      await assert.rejects(
        () => sessionStart({}, { sessionManager: { getSessionFile: () => target } }),
        /Invalid Paseo Pi bootstrap environment/,
      );

      const ready = JSON.parse(readFileSync(readyPath, "utf8"));
      assert.equal(ready.ok, false);
      assert.equal(ready.requestId, "malformed-1");
      assert.match(ready.error, /Invalid Paseo Pi bootstrap environment/);
    } finally {
      for (const name of names) {
        const value = saved.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("loads configured skill content into the child system prompt", async () => {
    const skillPath = join(root, "planning.md");
    writeFileSync(skillPath, "---\nname: planning\n---\nUse a short plan.\n");
    process.env[PASEO_BOOTSTRAP_ENV] = encodePaseoBootstrap({
      version: 1,
      skills: ["planning"],
    });
    const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
    const api = {
      getCommands: () => [
        { name: "skill:planning", source: "skill", sourceInfo: { path: skillPath, baseDir: root } },
      ],
      on(event: string, handler: (...args: any[]) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerCommand() {},
    };
    registerPaseoBootstrap(api as any);
    const beforeAgentStart = handlers.get("before_agent_start")?.[0];
    assert.ok(beforeAgentStart);
    const result = await beforeAgentStart({ systemPrompt: "Base prompt" }, {});
    assert.match(result.systemPrompt, /Use a short plan\./);
    assert.match(result.systemPrompt, /<skill name="planning"/);
  });

});
