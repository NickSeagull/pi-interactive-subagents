import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  canonicalPath,
  loadAccountPolicy,
  resolveAccountSelection,
} from "../pi-extension/subagents/account-scope.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join("/tmp", "pi-account-scope-"));
  temporaryDirectories.push(root);
  const policyDirectory = join(root, "config");
  mkdirSync(policyDirectory, { recursive: true });
  const policyFile = join(policyDirectory, "accounts.json");
  writeFileSync(
    policyFile,
    JSON.stringify({
      personalAgentDir: "../personal-agent",
      companyAgentDir: "../company-agent",
      companyRoots: ["../company-project"],
      ...overrides,
    }),
  );
  return {
    root,
    policyFile,
    policy: loadAccountPolicy(policyFile),
    companyRoot: join(root, "company-project"),
  };
}

function makeDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

describe("account scope policy", () => {
  it("selects personal credentials for a root outside company paths", () => {
    const { policy, root } = fixture();
    const selection = resolveAccountSelection({
      policy,
      cwd: makeDirectory(join(root, "open-source")),
    });

    assert.equal(selection.scope, "personal");
    assert.equal(selection.credentialDir, policy.personalAgentDir);
    assert.equal(selection.reason, "default-personal");
  });

  it("selects company credentials when the session root is a company path", () => {
    const { policy, companyRoot } = fixture();
    const selection = resolveAccountSelection({
      policy,
      cwd: makeDirectory(join(companyRoot, "repo", "src")),
    });

    assert.equal(selection.scope, "company");
    assert.equal(selection.credentialDir, policy.companyAgentDir);
    assert.equal(selection.reason, "company-directory-rule");
  });

  it("keeps a company parent sticky for a child outside company paths", () => {
    const { policy, root } = fixture();
    const selection = resolveAccountSelection({
      policy,
      cwd: makeDirectory(join(root, "open-source-child")),
      parentScope: "company",
    });

    assert.equal(selection.scope, "company");
    assert.equal(selection.credentialDir, policy.companyAgentDir);
    assert.equal(selection.reason, "company-parent-scope");
  });

  it("upgrades a personal parent when a child cwd is inside company paths", () => {
    const { policy, companyRoot } = fixture();
    const selection = resolveAccountSelection({
      policy,
      cwd: makeDirectory(join(companyRoot, "company-child")),
      parentScope: "personal",
    });

    assert.equal(selection.scope, "company");
    assert.equal(selection.reason, "company-directory-rule");
  });

  it("keeps a company child sticky for descendants outside company paths", () => {
    const { policy, root } = fixture();
    const selection = resolveAccountSelection({
      policy,
      cwd: makeDirectory(join(root, "descendant")),
      parentScope: "company",
      persistedScope: "company",
    });

    assert.equal(selection.scope, "company");
    assert.equal(selection.reason, "persisted-company-scope");
  });

  it("keeps a persisted company child on resume outside company paths", () => {
    const { policy, root } = fixture();
    const selection = resolveAccountSelection({
      policy,
      cwd: makeDirectory(join(root, "resumed-elsewhere")),
      persistedScope: "company",
    });

    assert.equal(selection.scope, "company");
    assert.equal(selection.credentialDir, policy.companyAgentDir);
    assert.equal(selection.reason, "persisted-company-scope");
  });

  it("resolves concurrent personal and company sessions to distinct stores", () => {
    const { policy, root, companyRoot } = fixture();
    const personal = resolveAccountSelection({
      policy,
      cwd: makeDirectory(join(root, "personal-repo")),
    });
    const company = resolveAccountSelection({
      policy,
      cwd: makeDirectory(join(companyRoot, "company-repo")),
    });

    assert.equal(personal.scope, "personal");
    assert.equal(company.scope, "company");
    assert.notEqual(personal.credentialDir, company.credentialDir);
  });

  it("does not fall back to personal when the selected company directory is absent", () => {
    const { policy, root, companyRoot } = fixture({
      companyAgentDir: "../credentials/company-not-provisioned",
    });
    const selection = resolveAccountSelection({
      policy,
      cwd: makeDirectory(join(companyRoot, "needs-company")),
    });

    assert.equal(selection.scope, "company");
    assert.equal(selection.credentialDir, policy.companyAgentDir);
    assert.equal(existsSync(selection.credentialDir), false);
    assert.notEqual(selection.credentialDir, policy.personalAgentDir);
    assert.equal(existsSync(join(root, "credentials")), false);
  });

  it("ignores daemon ambient Pi directory because selection uses explicit policy paths", () => {
    const { policy, root } = fixture();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "ambient-daemon-directory");
    try {
      const selection = resolveAccountSelection({
        policy,
        cwd: makeDirectory(join(root, "open-source")),
      });
      assert.equal(selection.credentialDir, policy.personalAgentDir);
      assert.notEqual(selection.credentialDir, process.env.PI_CODING_AGENT_DIR);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("honors an explicit company override outside configured roots", () => {
    const { policy, root } = fixture();
    const selection = resolveAccountSelection({
      policy,
      cwd: makeDirectory(join(root, "one-off-company-task")),
      forceCompany: true,
    });

    assert.equal(selection.scope, "company");
    assert.equal(selection.reason, "explicit-company-override");
  });
});

describe("account scope path and validation rules", () => {
  it("canonicalizes symlinked roots and future paths", () => {
    const root = mkdtempSync(join("/tmp", "pi-account-scope-links-"));
    temporaryDirectories.push(root);
    const realRoot = makeDirectory(join(root, "real-company"));
    const linkedRoot = join(root, "company-link");
    symlinkSync(realRoot, linkedRoot, "dir");
    const policyDirectory = makeDirectory(join(root, "policy"));
    const policyFile = join(policyDirectory, "accounts.json");
    writeFileSync(
      policyFile,
      JSON.stringify({
        personalAgentDir: "../personal",
        companyAgentDir: "../company",
        companyRoots: ["../company-link"],
      }),
    );
    const policy = loadAccountPolicy(policyFile);
    const futurePath = canonicalPath(join(linkedRoot, "future", "repo"));
    const selection = resolveAccountSelection({
      policy,
      cwd: makeDirectory(join(realRoot, "repo")),
    });

    assert.equal(policy.companyRoots[0], canonicalPath(realRoot));
    assert.equal(futurePath, join(canonicalPath(realRoot), "future", "repo"));
    assert.equal(selection.scope, "company");
  });

  it("uses path boundaries so company does not match a similarly prefixed sibling", () => {
    const { policy, root, companyRoot } = fixture();
    const sibling = makeDirectory(`${companyRoot}-other`);
    const selection = resolveAccountSelection({ policy, cwd: sibling });

    assert.equal(selection.scope, "personal");
  });

  it("rejects unknown scope markers and malformed forceCompany values", () => {
    const { policy, root } = fixture();
    const cwd = makeDirectory(join(root, "repo"));

    assert.throws(
      () => resolveAccountSelection({ policy, cwd, parentScope: "work" as never }),
      /parentScope must be 'personal' or 'company'/,
    );
    assert.throws(
      () => resolveAccountSelection({ policy, cwd, persistedScope: "corp" as never }),
      /persistedScope must be 'personal' or 'company'/,
    );
    assert.throws(
      () => resolveAccountSelection({ policy, cwd, forceCompany: "true" as never }),
      /forceCompany must be a boolean/,
    );
  });

  it("rejects credential directories that resolve to the same or nested path", () => {
    const root = mkdtempSync(join("/tmp", "pi-account-scope-overlap-"));
    temporaryDirectories.push(root);
    const policyDirectory = makeDirectory(join(root, "policy"));
    const policyFile = join(policyDirectory, "accounts.json");

    writeFileSync(
      policyFile,
      JSON.stringify({
        personalAgentDir: "../credentials",
        companyAgentDir: "../credentials",
        companyRoots: [],
      }),
    );
    assert.throws(() => loadAccountPolicy(policyFile), /must not overlap/);

    writeFileSync(
      policyFile,
      JSON.stringify({
        personalAgentDir: "../credentials",
        companyAgentDir: "../credentials/company",
        companyRoots: [],
      }),
    );
    assert.throws(() => loadAccountPolicy(policyFile), /must not overlap/);
  });

  it("requires all credential paths and company roots while accepting future paths", () => {
    const root = mkdtempSync(join("/tmp", "pi-account-scope-required-"));
    temporaryDirectories.push(root);
    const policyFile = join(root, "accounts.json");
    writeFileSync(
      policyFile,
      JSON.stringify({
        personalAgentDir: "./future/personal",
        companyAgentDir: "./future/company",
        companyRoots: [],
        sharedConfigDir: "~/shared-pi-config",
      }),
    );

    const policy = loadAccountPolicy(policyFile);
    assert.equal(policy.policyFile, canonicalPath(policyFile));
    assert.equal(policy.personalAgentDir, canonicalPath(join(root, "future", "personal")));
    assert.equal(policy.companyAgentDir, canonicalPath(join(root, "future", "company")));
    assert.equal(policy.sharedConfigDir, join(homedir(), "shared-pi-config"));
    assert.deepEqual(policy.companyRoots, []);

    writeFileSync(
      policyFile,
      JSON.stringify({ personalAgentDir: "./personal-agent", companyRoots: [] }),
    );
    assert.throws(() => loadAccountPolicy(policyFile), /requires 'companyAgentDir'/);
  });

  it("does not treat a policy file's sibling credential files as policy input", () => {
    const root = mkdtempSync(join("/tmp", "pi-account-scope-input-"));
    temporaryDirectories.push(root);
    const policyFile = join(root, "policy.json");
    writeFileSync(
      policyFile,
      JSON.stringify({
        personalAgentDir: "./personal",
        companyAgentDir: "./company",
        companyRoots: [],
      }),
    );
    // A credential-like file is deliberately not read or interpreted.
    writeFileSync(join(root, "auth.json"), "not policy input");

    const policy = loadAccountPolicy(policyFile);
    assert.equal(dirname(policy.policyFile), canonicalPath(root));
    assert.equal(policy.companyRoots.length, 0);
  });
});
