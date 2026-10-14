# Admin dispute and content review audit

Scope: booking disputes, safety reports, cancellation/completion escalations, public listing/request reports and appeals, and booking conversation review. Audited against the current backend and frontend implementation. Unrelated landing-page and document changes are outside this work.

## Decision boundaries

| Case | Valid admin decisions | Effect |
| --- | --- | --- |
| Safety report | Dismiss, uphold the safety finding, or cancel eligible active work | Dismissal has no account penalty. Upholding can include a separately selected, evidence-based penalty. Closing the final blocking report can resume paused work. Terminal bookings retain their settled payment state. |
| Completion dispute | Dismiss, cancel/refund, or confirm completion in the provider's favor | Completion settlement requires the original awaiting-confirmation path. Refund/completion effects must reach a valid final state before the case closes. |
| Cancellation escalation | Approve or decline the linked cancellation | Approval cancels work and refunds held online payments. For started work, fault must be recorded before deducting trust points. Declining does not release payment. |
| Completion escalation | Continue awaiting confirmation, refund/cancel, or confirm completion | A provider escalates after 72 hours without confirmation. Continuing to wait closes that escalation and applies a 72-hour retry cooldown. An escalation alone does not pause the booking. |
| Public content report | Dismiss, remove, or keep previously removed content hidden | Content visibility is separate from booking/payment settlement. Owner penalties are optional and require a confirmed violation. Removing a request with active booking/payment obligations is blocked. |
| Content appeal | Restore eligible removed content, keep it removed, or send guidance | Restoration rechecks owner/category/content eligibility and listing limits. Rejected offers stay rejected when a request is restored. Appeals cannot impose an account penalty. |

Online money movements in this system use PayMongo Test Mode. Cash is paid outside ServiceHub; the platform cannot issue a cash refund. Existing financial resolution operations are resumed rather than repeated.

## Corrections

1. **Account restrictions:** report penalties no longer set `isActive` to true. A suspension cannot weaken an existing ban or overwrite another suspension. Admin/self/inactive/deactivated targets are rejected before a new decision is claimed. Outstanding unstarted provider bookings block suspension, with the currently cancelled booking excluded from the initial check when appropriate.
2. **Changed accounts during retries:** finalization rechecks the account under its lifecycle lock. If a previously claimed penalty has become invalid, the case can finish while preserving the existing restriction. The actual applied penalty and explanation are recorded in the operation, audit log, participant notifications, and recorded-decision UI.
3. **Conversation scope and scale:** admins fetch at most 50 messages per page. Cursors are constrained to the selected booking and ordered by timestamp plus ID, so tied timestamps do not lose or duplicate messages. Each fetched page remains admin-only and audit logged.
4. **Conversation readability:** both case review and booking operations use one bounded, keyboard-focusable scroll region, with sender name, seeker/provider role, timestamp, preserved line breaks, and system-update labels. Older messages load on demand. Failed page loads retain the visible evidence and support retry. Changing/closing the selected booking invalidates late responses.
5. **Photo evidence:** new reports and appeals save the original photo set alongside the original text. Admins can browse those photos and disclose the changed current version. Older reports explicitly identify missing original photos; current photos are not presented as original evidence. Referenced photos are excluded from manual unused-photo deletion and abandoned-upload cleanup for as long as the saved case references them.

## Review process

Open the case, read the complaint, inspect the booking and participants, review the booking conversation and supplied evidence, then choose an outcome. Add an explanation, review the effects, and acknowledge the consequences before submitting. Use case history for closed decisions. Handle remaining booking obligations separately when an account is restricted.

The existing booking locks, durable financial-operation stages, stale-content checks, confirmation steps, audit records, and notifications are retained. A pending completion escalation is not treated as an additional pause when restoring a safety report: it must be able to return to awaiting confirmation for its own review path to proceed.

## Verification results — 14 October 2026

- **Passed: 15 targeted backend tests** covering allowed decisions, account penalty eligibility, stronger restrictions, retries, suspension blockers, and bounded message inputs.
- **Passed: 25 targeted frontend tests** covering outcome confirmation, dismissal without punishment, cancellation fault, terminal case display, independent loading errors, stale chat responses, older-page retry/deduplication, and original/current photo evidence.
- **Passed: all four isolated integration suites:** admin review lifecycle (7 tests), content workspace (10 tests), H1–H5 booking/dispute/refund recovery, and participant safety/review moderation/self-deletion. The older safety fixture was updated to specify a policy violation before hiding a review, and now also verifies that hiding without a violation is rejected. The safety suite was rerun independently after this test correction; the successful suites were not repeated.
- Isolated integration command: `SERVICEHUB_ADMIN_CASES_ONLY=1 npm run test:fresh-migrations`. The harness verifies a generated disposable schema, applies current migrations there, runs admin/content/booking safety suites, and drops that schema afterward. It must not be replaced by running these suites against live data.
- **Passed: desktop light and mobile dark browser QA** using illustrative fixtures with intercepted API and socket traffic. The conversation remains a 478-pixel scroll area while holding 100 loaded messages; neither screen has horizontal overflow or page errors. Original-photo carousel controls and changed-version disclosure work. Captures and geometry results are saved in the frontend `.impeccable/review/admin-*` files.
- **Passed: backend build, frontend production build, targeted frontend lint, and changed-file whitespace checks.** All current migrations were applied and checked for schema drift in the disposable databases; those test schemas were removed after their runs.

This is a focused lifecycle audit; it is not a claim that every unrelated admin feature has been exhaustively tested.
