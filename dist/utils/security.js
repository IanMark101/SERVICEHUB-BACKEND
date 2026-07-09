"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertDistinctAccounts = assertDistinctAccounts;
/**
 * Asserts that two user accounts involved in a transaction or interaction are distinct.
 * Throws a 403 Forbidden error with a standardized code if they match.
 */
function assertDistinctAccounts(accountAId, accountBId, actionName) {
    if (accountAId === accountBId) {
        const err = new Error(`Self-transaction forbidden: You cannot perform "${actionName}" on your own account.`);
        err.status = 403;
        err.code = "SELF_TRANSACTION_NOT_ALLOWED";
        throw err;
    }
}
//# sourceMappingURL=security.js.map