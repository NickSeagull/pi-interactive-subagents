import type { AccountPolicy, AccountSelection } from "./account-scope.mjs";
export function prepareAccountProfile(selection: AccountSelection, policy: AccountPolicy): Promise<AccountSelection>;
