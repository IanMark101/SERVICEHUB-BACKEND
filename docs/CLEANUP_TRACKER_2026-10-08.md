# Cleanup tracker — 2026-10-08

Branch in both application repositories: `feature/safe-codebase-cleanup-2026-10-08`  
Date/timezone: 2026-10-08, Asia/Taipei  
Status: **Checklists created. Cleanup execution has not started. 0 items deleted.**

This document is the workspace overview. Each repository checklist owns its item checkboxes and change log:

- [Frontend deletion checklist](../../SERVICEHUB-FRONTEND/CLEANUP_CHECKLIST_2026-10-08.md)
- [Backend deletion checklist](../CLEANUP_CHECKLIST_2026-10-08.md)

The overview is stored in the backend repository so it can be versioned on its cleanup branch. Source files, skills, and documents at the parent workspace root are outside both application Git repositories. Switching an application branch does not isolate or back up those shared files.

## Progress overview

| Owner | First batch | Deferred | Manual review | Total planning entries | Deleted |
| --- | ---: | ---: | ---: | ---: | ---: |
| Frontend | 28 | 3 | 12 | 43 | 0 |
| Backend | 1 | 2 | 18 | 21 | 0 |
| Shared workspace | 0 | 0 | 42 | 42 | 0 |
| **Total** | **29** | **5** | **72** | **106** | **0** |

Counts are planning entries, not file totals inside folders. Manifest-review entries concern individual declarations; the manifests themselves must stay.

The original audit identified 108 potential cleanup entries. Two have been moved to the protected set following the user's preference: the empty workspace `.impeccable/` directory and frontend `.impeccable/review/admin-inspection/`. The remaining 106 entries consist of 29 first-batch entries, five deferred candidates, and 72 manual-review entries.

## First-batch boundary

Only the repository checklist's FE-001 through FE-028 and BE-001 form the initial small deletion set: 18 unreachable frontend modules, two unused React/Vite starter assets, eight empty QA route folders, and the backend's pasted branch listing. Do not add original artwork, generated clients, logs, public assets, dependencies, tests, migration helpers, backups, documentation, or skill folders to this batch.

Deletion and approval are separate from creating this tracking document. No checkbox is checked for a deletion, and no removed file or verification result is claimed here.

## Protected — keep

These paths are excluded from deletion and refactoring in this cleanup.

- `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_MASTER_PROMPT.md` — Keep the workspace master-prompt pointer.
- `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/docs/SERVICEHUB_MASTER_PROMPT.md` — Keep the authoritative current master prompt.
- `C:/Users/SERVICEHUB-CORDOVA/fullstack/.agents/` — Keep all bundled Impeccable and Design Taste Frontend skill files, scripts, binaries, references, and agent definitions.
- `C:/Users/SERVICEHUB-CORDOVA/fullstack/.codex/` — Keep hook configuration and supporting agent configuration.
- `C:/Users/SERVICEHUB-CORDOVA/fullstack/skills-lock.json` — Keep installed-skill metadata.
- `C:/Users/SERVICEHUB-CORDOVA/fullstack/.impeccable/` — Keep even though currently empty; excluded from cleanup by the user's preference.
- `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-FRONTEND/.impeccable/` — Keep surface direction, review records, and screenshots; the whole directory is protected.
- `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-FRONTEND/PRODUCT.md` — Keep current product/design authority.
- `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-FRONTEND/AGENTS.md` — Keep Next.js agent guidance.
- `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-FRONTEND/CLAUDE.md` — Keep the intentional AGENTS.md pointer.
- `C:/Users/SERVICEHUB-CORDOVA/fullstack/CAPSTONE_DOCUMENTATION/` — Keep original capstone deliverables.

Keep current application routes, live components, tests, migrations, environment files, installed dependencies, build output, vendor licenses, operational tooling, and package manifests/lockfiles. A manual-review entry for a manifest refers only to individual declarations, not deletion of the manifest.

## Tracking rules

- A deletion checkbox means **actually deleted**. Keep it unchecked until removal has been confirmed.
- Record each removal or restoration by its stable ID in the change log. Include the snapshot/rollback reference, verification result, and commit reference when available.
- If a file is restored, uncheck its deletion entry and record the restoration.
- Verification is recorded separately. A checked deletion entry alone does not mean its batch passed verification.
- Deferred entries and review entries are not part of the first batch.
- "Review" means decide whether to keep, document, wire into tests, or retire. It does not mean approved for deletion.
- If references or contents have changed since the audit, stop that item's removal and return it to review.
- For an empty-folder candidate, recheck that it is empty immediately before removal. Git does not track empty directories.
- Use exact allowlisted paths. Do not bulk-delete by name pattern, stage unrelated existing changes, or modify preserved application behavior.

## Shared workspace — manual review only

Keep these items until their references, operational use, and retention value have been reviewed. Historical reports can contain reproduction instructions and cross-document links even when the application never imports them.

| ID | Full path | Review reason | Decision | Removal status |
| --- | --- | --- | --- | --- |
| WS-R-001 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/.cleanup-backups/` | Recovery archives, manifests and logs; retain until a separate rollback-retention decision. | Pending review | Not scheduled |
| WS-R-002 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/artifacts/admin-sidebar-2026-10-07/` | Sidebar screenshot evidence; review submission/QA retention. | Pending review | Not scheduled |
| WS-R-003 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/tools/update_capstone_payment_scope.py` | One-off capstone document correction; confirm document scope is final. | Pending review | Not scheduled |
| WS-R-004 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/tools/render_capstone_docs_with_word.ps1` | Capstone rendering/QA workflow; confirm retirement before removal. | Pending review | Not scheduled |
| WS-R-005 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/CLEANUP_AUDIT_2026-10-05.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-006 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/CLEANUP_IMPLEMENTATION_2026-10-05.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-007 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/CROSS_DOMAIN_COOKIE_AUDIT_2026-10-05.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-008 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/OFFER_REQUEST_ACTIVITY_AUDIT.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-009 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/PROVIDER_ACTIVITY_VISUAL_REDESIGN_PLAN.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-010 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/REQUEST_DELETE_AND_FEEDBACK_FIX_2026-10-05.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-011 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_ACCOUNT_DELETION_IMPLEMENTATION_2026-09-30.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-012 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_ADMIN_AUDIT_2026-09-30.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-013 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_ADMIN_DISPUTES_IMPLEMENTATION_2026-09-30.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-014 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_ADMIN_REPORTS_UX_AUDIT_2026-10-07.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-015 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_AUDIT_PROGRESS_CHECKPOINT.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-016 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_AUTH_FORM_RENDERING_FIX_2026-10-03.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-017 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_CONTENT_WORKSPACE_IMPLEMENTATION_2026-10-01.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-018 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_CRITICAL_FIX_REPORT_2026-09-18.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-019 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_E2E_AUDIT_2026-09-18.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-020 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_FORM_UI_CONSISTENCY_2026-10-03.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-021 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_HARD_DELETION_REPORT_2026-09-30.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-022 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_HERO_MOTION_2026-10-04.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-023 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_HERO_REDESIGN_2026-10-04.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-024 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_HIGH_PRIORITY_FIX_REPORT_2026-09-19.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-025 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_INDEPENDENT_VERIFICATION_2026-09-25.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-026 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_LANDING_RENDERING_FIX_2026-10-02.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-027 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_LANDING_SESSION_NAVIGATION_FIX_2026-10-04.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-028 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_LANDING_STRUCTURE_AUDIT_2026-10-03.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-029 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_LANDING_UI_UX_AUDIT_2026-10-03.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-030 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_LISTING_PUBLICATION_REPORT_2026-09-30.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-031 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_MODAL_DARK_MODE_AUDIT_2026-10-04.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-032 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_NAVIGATION_MOTION_FIX_2026-10-03.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-033 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_PASSWORD_MANAGEMENT_REPORT_2026-09-30.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-034 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_PUBLIC_AUTH_DEV_RECOVERY_2026-10-04.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-035 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_REFRESH_SESSION_FIX_2026-10-03.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-036 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_REGRESSION_VERIFICATION_2026-09-25.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-037 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_REPORTS_UX_AUDIT_2026-10-03.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-038 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_REVIEW_DIGEST_AUDIT_2026-10-05.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-039 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_REVIEW_DIGEST_REAUDIT_2026-10-07.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-040 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB_SESSION_ROUTING_FIX_2026-10-02.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-041 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SKELETON_AND_FOOTER_AUDIT_2026-10-05.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |
| WS-R-042 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/TRUST_SCORE_AUDIT_AND_FIX_2026-10-05.md` | Historical audit/fix/design evidence; review cross-document references and retention. No runtime consumer was found. | Pending review | Not scheduled |

No shared-workspace deletion is part of the first batch. Any future action here must be recorded individually and backed up separately from the two application repositories.

## Recovery and verification progress

- [x] Frontend and backend are on the named cleanup branches.
- [x] Protected master-prompt, skill, hook, and design-record paths are recorded.
- [ ] Create a current recovery snapshot of retained files, existing tracked modifications, and untracked source/support files.
- [ ] Record frontend baseline checks before physical cleanup.
- [ ] Complete the first-batch deletion checkboxes and change logs in both repository checklists.
- [ ] Complete frontend post-cleanup checks and fixture-based UI smoke checks.
- [ ] Confirm every retained file and protected path is unchanged relative to the recovery snapshot.
- [ ] Update this overview's deletion counts from the repository checklists.
- [ ] Record cleanup commits containing only the approved removals and their tracker updates.

Prior audit evidence: frontend in-memory TypeScript checks passed both with current files and with the 18 unreachable modules hidden; backend in-memory TypeScript checks passed with and without the obsolete custom-output client. Those checks did not physically delete anything and are not a substitute for recording baseline and post-removal results during execution.

## Verification log

| Batch | Baseline | After removal | UI/behavior checks | Retained-file integrity | Result |
| --- | --- | --- | --- | --- | --- |
| Initial first batch | Not run for execution | Not run | Not run | Not run against a recovery snapshot | Pending; no deletion |
| Deferred generated-client pass | Not scheduled | Not run | Not run | Not run | Deferred |
| Manual-review items | Not scheduled | Not run | Not run | Not run | Keep pending review |

## Change log

Append one row per item action. No cleanup deletion has occurred as of tracker creation.

| Date/time (Asia/Taipei) | Item ID | Action | Recovery reference | Verification | Commit/reference | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-08 | — | Tracker created; no deletion | Not created yet | Documentation only | Git history when committed | Existing local edits preserved |
