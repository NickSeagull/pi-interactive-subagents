export type AccountScope = "personal" | "company";

export interface AccountSessionMetadata {
  scope?: AccountScope;
  cwd?: string;
  credentialDir?: string;
  policyFile?: string;
  version?: number;
}

export const ACCOUNT_SESSION_CUSTOM_TYPE: "pi-account-scope";
export const ACCOUNT_SESSION_VERSION: 1;
export function validateAccountSessionFile(sessionFile: string, options?: { requireHeader?: boolean; allowMissing?: boolean }): string;

export function readAccountSessionMetadata(sessionFile: string): AccountSessionMetadata;
export function readAccountSessionScope(sessionFile: string): AccountSessionMetadata;
export function createAccountSessionEntry(
  selection: AccountSessionMetadata & {
    scope: AccountScope;
    credentialDir: string;
    policyFile: string;
    cwd: string;
  },
  parentId?: string,
): Record<string, unknown>;
export function persistAccountSessionScope(
  sessionFile: string,
  selection: AccountSessionMetadata & {
    scope: AccountScope;
    credentialDir: string;
    policyFile: string;
    cwd: string;
  },
  parentId?: string,
): { appended: boolean; metadata: AccountSessionMetadata; entry?: Record<string, unknown> };
export const appendAccountSessionScope: typeof persistAccountSessionScope;
