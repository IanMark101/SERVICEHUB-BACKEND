/**
 * Asserts that two user accounts involved in a transaction or interaction are distinct.
 * Throws a 403 Forbidden error with a standardized code if they match.
 */
export function assertDistinctAccounts(accountAId: string, accountBId: string, actionName: string): void {
  if (accountAId === accountBId) {
    const err = new Error(`Self-transaction forbidden: You cannot perform "${actionName}" on your own account.`) as any;
    err.status = 403;
    err.code = "SELF_TRANSACTION_NOT_ALLOWED";
    throw err;
  }
}
