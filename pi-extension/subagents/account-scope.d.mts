export type AccountScope = "personal" | "company";

export interface AccountPolicy {
  policyFile: string;
  personalAgentDir: string;
  companyAgentDir: string;
  companyRoots: string[];
  sharedConfigDir?: string;
}

export interface AccountSelection {
  scope: AccountScope;
  credentialDir: string;
  policyFile: string;
  reason: string;
  cwd: string;
}

export function canonicalPath(value: string, baseDir?: string): string;
export function loadAccountPolicy(file: string): AccountPolicy;
export function resolveAccountSelection(input: {
  policy: AccountPolicy;
  cwd: string;
  parentScope?: AccountScope | null;
  persistedScope?: AccountScope | null;
  forceCompany?: boolean;
}): AccountSelection;
