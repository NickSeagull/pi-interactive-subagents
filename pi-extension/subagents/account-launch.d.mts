import type { AccountSelection } from "./account-scope.mjs";
export interface ScopedLaunch extends AccountSelection {
  command: string[];
  env: Record<string, string>;
}
export function prepareScopedLaunch(input: {
  cwd: string;
  parentSessionFile?: string | null;
  sessionFile?: string;
  env?: Record<string, string | undefined>;
}): Promise<ScopedLaunch | undefined>;
