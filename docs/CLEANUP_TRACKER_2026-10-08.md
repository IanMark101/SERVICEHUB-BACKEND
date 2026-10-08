# Cleanup tracker — 2026-10-08

Branch in both application repositories: `feature/safe-codebase-cleanup-2026-10-08`  
Date/timezone: 2026-10-08, Asia/Taipei  
Status: **32 cleanup entries removed and backed up. Frontend: 700 tests pass and lint is clean. Backend: build and 111 contract tests pass. Interactive browser review remains pending.**

This document is the workspace overview. Each repository checklist owns its item checkboxes and change log:

- [Frontend deletion checklist](../../SERVICEHUB-FRONTEND/CLEANUP_CHECKLIST_2026-10-08.md)
- [Backend deletion checklist](../CLEANUP_CHECKLIST_2026-10-08.md)

The overview is stored in the backend repository so it can be versioned on its cleanup branch. Source files, skills, and documents at the parent workspace root are outside both application Git repositories. Switching an application branch does not isolate or back up those shared files.

## Progress overview

| Owner | First batch | Deferred | Manual review | Total planning entries | Deleted |
| --- | ---: | ---: | ---: | ---: | ---: |
| Frontend | 28 | 3 | 12 | 43 | 30 |
| Backend | 1 | 2 | 18 | 21 | 2 |
| Shared workspace | 0 | 0 | 42 | 42 | 0 |
| **Total** | **29** | **5** | **72** | **106** | **32** |

Counts are planning entries, not file totals inside folders. Manifest-review entries concern individual declarations; the manifests themselves must stay.

The original audit identified 108 potential cleanup entries. Two have been moved to the protected set following the user's preference: the empty workspace `.impeccable/` directory and frontend `.impeccable/review/admin-inspection/`. The remaining 106 entries consist of 29 first-batch entries, five deferred candidates, and 72 manual-review entries.

## First-batch boundary

Only the repository checklist's FE-001 through FE-028 and BE-001 form the initial small deletion set: 18 unreachable frontend modules, two unused React/Vite starter assets, eight empty QA route folders, and the backend's pasted branch listing. Do not add original artwork, generated clients, logs, public assets, dependencies, tests, migration helpers, backups, documentation, or skill folders to this batch.

The user authorized the first cleanup batch after tracker creation. All 29 items have been removed and recorded individually in the repository checklists. Deferred and manual-review entries remain excluded.

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
- [x] Create a current recovery snapshot of retained files, existing tracked modifications, and untracked source/support files.
- [x] Record frontend baseline checks before physical cleanup.
- [x] Complete the first-batch deletion checkboxes and change logs in both repository checklists.
- [x] Complete frontend automated post-cleanup checks and fixture HTTP/prerender checks.
- [ ] Complete hydrated-browser fixture smoke review; no browser is exposed in this resumed session.
- [x] Confirm every retained file and protected path is unchanged relative to the recovery snapshot.
- [x] Update this overview's deletion counts from the repository checklists.
- [x] Record cleanup commits containing only the approved removals and their tracker updates.

Prior audit evidence: frontend in-memory TypeScript checks passed both with current files and with the 18 unreachable modules hidden; backend in-memory TypeScript checks passed with and without the obsolete custom-output client. Those checks did not physically delete anything and are not a substitute for recording baseline and post-removal results during execution.

## Verification log

| Batch | Baseline | After removal | UI/behavior checks | Retained-file integrity | Result |
| --- | --- | --- | --- | --- | --- |
| Initial first batch | TypeScript/build/prerender passed; tests 690 pass/8 fail; lint 1 error/6 warnings | Same test failures and lint diagnostics; TypeScript/build/prerender passed | Six fixture routes HTTP 200; route manifest/CSS checked; interactive review pending | 1,013 retained files and 87 protected files match snapshot | No new automated failures detected; browser review still pending |
| Deferred generated-client pass | Not scheduled | Not run | Not run | Not run | Deferred |
| Manual-review items | Not scheduled | Not run | Not run | Not run | Keep pending review |

## Change log

Item actions are recorded individually in the repository checklists; workspace progress is recorded here.

| Date/time (Asia/Taipei) | Item ID | Action | Recovery reference | Verification | Commit/reference | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-08 | — | Tracker created; no deletion | Not created yet | Documentation only | Git history when committed | Existing local edits preserved |

## Execution checkpoint

The work was paused at the user's request before deletion and resumed on 2026-10-08. Resume checks confirmed unchanged source files and branch heads, all eight QA folders still empty, and no new reachable consumers. Baseline tests/lint have existing failures; production build and TypeScript passed. All 29 first-batch entries are removed. Tests/lint match the recorded failures, TypeScript/build/prerender checks pass, all 60 application page entries remain, and retained-file hashes match. The cleanup commits include only these removals and tracking updates. Interactive browser smoke review remains pending because the browser inventory in this resumed session is empty.

Recovery: C:/Users/SERVICEHUB-CORDOVA/fullstack/.cleanup-backups/2026-10-08-safe-cleanup/snapshot.json, with originals under files/ and a guarded restore-first-batch.cjs script. The recovery directory is local and ignored; it is not part of the cleanup commits. Run the restoration script only to roll back all 29 missing paths; it refuses to overwrite existing files. Update the checklists if any item is restored.

## Next review

The resumed pass removed three verified deferred artifacts, retained the original hero artwork for polishing/manual review, and confirmed the three current audit logs are required evidence. All 72 original manual-review entries remain retained. Existing frontend test expectations and lint diagnostics are resolved in the current working tree. Complete hydrated-browser smoke review before merging. Further feature/polishing work can proceed without deleting uncertain assets, tools, documentation, tests, or dependencies.

The 29 entries comprise 21 files and eight empty folders. Git records file deletions; empty folders are tracked in the checklists/removal log and can be recreated by the guarded recovery script. Recovery preserves the exact pre-cleanup working-tree versions, including local edits; a Git revert alone restores the older committed versions.


## Resumed pass and final decisions — 2026-10-08

| ID / full path | Purpose and current use | Classification / decision | Reason and removal risk |
| --- | --- | --- | --- |
| FE-D-001 — C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-FRONTEND/src/assets/hero.png | Original artwork; no current executable import found | Needs manual review — kept | May be useful in upcoming polishing. Removal loses editable/source artwork; retention is unresolved. |
| FE-D-002 — C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-FRONTEND/tsconfig.tsbuildinfo | Ignored TypeScript incremental cache, read/written automatically when incremental mode runs | Safe candidate — removed | Regenerable cache, not application code. No build/typecheck writer was running. Next incremental check can be slower; exact bytes backed up. |
| FE-D-003 — C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-FRONTEND/.safety-report-qa/ | Empty prior QA output directory; no script/config/route consumer found | Safe candidate — removed | Rechecked empty immediately before removal. Negligible application risk; future QA can recreate it. |
| BE-D-001 — C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/ | Obsolete generated client, 21 files; old embedded schema targets this location | Safe candidate — removed | Current generator, runtime imports, CI and Docker use node_modules client output. Virtual TypeScript plus physical build/tests pass without it. Legacy manual commands could require restoring the saved copy. Active clients remain intact. |
| BE-D-002 — C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/.audit-results/ | Three historical verification logs written by the audit runner and linked from SERVICEHUB_REVIEW_DIGEST_REAUDIT_2026-10-07.md | Required — keep | Historical evidence is consumed by retained documentation. Deletion would break its three evidence links. |

Of 106 planning entries: **32 safe candidates removed**, **73 retained for manual review** (72 original entries plus hero artwork), and **one confirmed required evidence folder kept**. Protected prompt/skills/configuration/design authority are additional keep items outside these counts. Folder-child checklist entries do not increase planning-entry totals.

The second batch comprises 22 local ignored files and three removed directories (the empty QA folder and the now-empty generated-client parent/runtime folders), about 12.62 MiB. Combined with the first batch, 43 files and 11 directory paths were physically removed. These counts include generated output; only the first batch's 21 file deletions are versioned by Git. Empty directories and ignored artifacts are backed up and tracked in the checklists; switching branches does not restore them.

Latest validation: frontend 700/700 tests across 114 files, TypeScript, webpack production build, and landing/auth prerender checks pass; ESLint reports zero errors/warnings. Backend build and all 111 schema/contract tests across 33 files pass both before and after obsolete-client removal. No database integration run is claimed. Hydrated browser verification remains unchecked because no browser is exposed.

The two test expectation/fixture updates remain unstaged with the existing CAPTCHA/ActivityFeed implementation changes they exercise. They should be committed with those feature changes, not as a standalone commit against the older implementation. Standalone lint/font maintenance and checklist updates are independent cleanup changes. User-owned edits remain preserved; no feature source was refactored in this pass.

Recovery locations: .cleanup-backups/2026-10-08-safe-cleanup/ (first batch), .cleanup-backups/2026-10-08-validation/ (validation originals/evidence), and .cleanup-backups/2026-10-08-deferred-cleanup/ (second batch originals and guarded restoration). Keep all three until rollback retention is explicitly decided.

Recommendation: stop further deletion at this safe boundary, retain the 73 uncertain items for ongoing development, perform a short interactive smoke review before merging, and handle later retirement as separate changes after features stabilize. Neither repository was pushed or merged.
