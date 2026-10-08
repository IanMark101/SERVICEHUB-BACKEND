# Backend cleanup checklist — 2026-10-08

Branch: `feature/safe-codebase-cleanup-2026-10-08`  
Repository: `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/`  
Audit base commit, before tracker creation: `cb81bf8d3c2ad58f49f9fed2da981880761b561c`  
Status: **Planning only. 0 items deleted. No cleanup verification batch has run.**

[Workspace overview and shared-file review](docs/CLEANUP_TRACKER_2026-10-08.md) · [Frontend checklist](../SERVICEHUB-FRONTEND/CLEANUP_CHECKLIST_2026-10-08.md)

| Scope | Entries | Deleted |
| --- | ---: | ---: |
| First batch | 1 | 0 |
| Deferred candidates | 2 | 0 |
| Manual review | 18 | 0 |

Folder contents are listed separately below for eventual file-by-file tracking. The two parent folders remain two planning entries; their child checkboxes are not additional scope entries.

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

## First batch — pending deletion

- [ ] **BE-001** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/adfasdf` — Pasted Git branch listing; no application/tool consumer.

## Deferred — excluded from first batch

- [ ] **BE-D-001** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/` — Obsolete custom-output client. Current imports use @prisma/client; current schema no longer targets this directory. Handle separately after backend verification.
- [ ] **BE-D-002** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/.audit-results/` — Historical audit logs; preserve evidence until retention is settled. The audit runner writes new output rather than reading these logs.

The obsolete generated client was hidden in memory during the earlier audit without introducing backend TypeScript errors. Keep the active client under `node_modules/@prisma/client` and `node_modules/.prisma/client`. Do not regenerate or remove active dependencies as part of the first batch.

### BE-D-001 contents — src/generated/prisma

All child entries below remain deferred. Mark the parent folder complete only when every listed child is gone and the directory's removal has been confirmed. Re-inventory immediately before any future removal.

- [ ] **BE-D-001.001** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/client.d.ts`
- [ ] **BE-D-001.002** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/client.js`
- [ ] **BE-D-001.003** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/default.d.ts`
- [ ] **BE-D-001.004** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/default.js`
- [ ] **BE-D-001.005** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/edge.d.ts`
- [ ] **BE-D-001.006** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/edge.js`
- [ ] **BE-D-001.007** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/index-browser.js`
- [ ] **BE-D-001.008** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/index.d.ts`
- [ ] **BE-D-001.009** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/index.js`
- [ ] **BE-D-001.010** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/package.json`
- [ ] **BE-D-001.011** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/query_compiler_fast_bg.js`
- [ ] **BE-D-001.012** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/query_compiler_fast_bg.wasm`
- [ ] **BE-D-001.013** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/query_compiler_fast_bg.wasm-base64.js`
- [ ] **BE-D-001.014** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/runtime/client.d.ts`
- [ ] **BE-D-001.015** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/runtime/client.js`
- [ ] **BE-D-001.016** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/runtime/index-browser.d.ts`
- [ ] **BE-D-001.017** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/runtime/index-browser.js`
- [ ] **BE-D-001.018** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/runtime/wasm-compiler-edge.js`
- [ ] **BE-D-001.019** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/schema.prisma`
- [ ] **BE-D-001.020** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/wasm-edge-light-loader.mjs`
- [ ] **BE-D-001.021** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/generated/prisma/wasm-worker-loader.mjs`

### BE-D-002 contents — .audit-results

All child entries below remain deferred. Mark the parent folder complete only when every listed child is gone and the directory's removal has been confirmed. Re-inventory immediately before any future removal.

- [ ] **BE-D-002.001** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/.audit-results/audit_20260924_089fd4b1696d47d6b11014b9d4980bfc.log`
- [ ] **BE-D-002.002** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/.audit-results/audit_20260924_37747bedce514fd5a52318a20e4687d5.log`
- [ ] **BE-D-002.003** — `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/.audit-results/audit_20260924_f81804bc07b8404c941fa925d25937ec.log`

## Manual review — no deletion scheduled

| ID | Full path | Review reason | Decision | Removal status |
| --- | --- | --- | --- | --- |
| BE-R-001 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/nginx.config` | Legacy static SPA reference configuration; confirm no external host procedure still uses it. | Pending review | Not scheduled |
| BE-R-002 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/package.json` | Review only @types/bcryptjs and stale main: index.js metadata. Keep the manifest and the mysql2 security override; Prisma depends on mysql2. | Pending review | Not scheduled |
| BE-R-003 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/.database-backups/` | Pre-migration database backup; require a retention/recovery decision. | Pending review | Not scheduled |
| BE-R-004 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/scripts/apply-content-workspace-migration.ts` | Targeted content migration; confirm all supported deployments have completed it. | Pending review | Not scheduled |
| BE-R-005 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/scripts/apply-listing-publication-migration.ts` | Targeted listing migration; confirm deployment completion and recovery needs. | Pending review | Not scheduled |
| BE-R-006 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/scripts/apply-request-payment-migration.ts` | Targeted payment-method migration; confirm deployment completion and recovery needs. | Pending review | Not scheduled |
| BE-R-007 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/scripts/apply-request-visibility-migration.ts` | Documented visibility repair; confirm deployment completion and recovery needs. | Pending review | Not scheduled |
| BE-R-008 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/scripts/apply-sign-in-methods-migration.ts` | Targeted authentication migration; confirm deployment completion and recovery needs. | Pending review | Not scheduled |
| BE-R-009 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/scripts/repair-completed-cancellation-report.ts` | Exact-ID data repair; confirm incident closure and affected historical records. | Pending review | Not scheduled |
| BE-R-010 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/scripts/audit-offer-eligibility.ts` | Incident-specific diagnostic with hardcoded account/request filters; confirm retirement. | Pending review | Not scheduled |
| BE-R-011 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/integration/admin-user-profile.test.ts` | Active behavior coverage without configured execution. Prefer wiring into testing over deletion. | Pending review | Not scheduled |
| BE-R-012 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/integration/category-source-of-truth.test.ts` | Active behavior coverage without configured execution. Prefer wiring into testing over deletion. | Pending review | Not scheduled |
| BE-R-013 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/integration/email-gate-login.test.ts` | Active authentication coverage without configured execution. Prefer wiring into testing over deletion. | Pending review | Not scheduled |
| BE-R-014 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/integration/offer-lifecycle.test.ts` | Active lifecycle coverage with a generic manual-runner note; review execution wiring. | Pending review | Not scheduled |
| BE-R-015 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/services/bookings/direct-listing-pricing.test.ts` | Active pricing coverage outside the default test glob. Prefer wiring into testing over deletion. | Pending review | Not scheduled |
| BE-R-016 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/src/services/content-moderation.service.test.ts` | Active moderation coverage outside the default test glob. Prefer wiring into testing over deletion. | Pending review | Not scheduled |
| BE-R-017 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/OFFER_FLOW_AUDIT.md` | Historical investigation; review documentation retention. | Pending review | Not scheduled |
| BE-R-018 | `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/PUBLIC_REQUEST_VISIBILITY_FIX_2026-10-05.md` | Historical fix report containing operational instructions; transfer instructions before retirement. | Pending review | Not scheduled |

The six test entries cover current behavior. The recommended outcome is to retain them and review execution wiring; absence from the default command is not evidence that they should be deleted.

The database backup folder currently contains:

- `C:/Users/SERVICEHUB-CORDOVA/fullstack/SERVICEHUB-BACKEND/.database-backups/neon-public-pre-migration-20260911-113926.dump`

## Execution and verification gates

- [x] Confirmed the cleanup branch and preserved all pre-existing local changes.
- [ ] Create a recovery snapshot containing current tracked edits and untracked source/support files.
- [ ] Recheck that BE-001 is still only pasted branch output and has no consumer.
- [ ] Remove BE-001, update its checkbox, and record the action.
- [ ] Verify every retained backend and protected file matches the recovery snapshot.
- [ ] Confirm the first-batch diff contains only BE-001 and tracker updates.
- [ ] Record the result and synchronize counts in the workspace overview.

BE-001 is a non-executable text artifact. Backend build/test verification belongs to a later generated-client or dependency pass when that pass begins; it is not claimed complete here. Database-mutating integration suites must use a disposable test database/schema, rather than the application database.

Before any deferred BE-D-001 removal, record backend typechecking, `npm run build`, and appropriate contract/integration verification, and verify current Prisma configuration/import resolution. Before any BE-D-002 removal, decide whether the historical logs still need retention.

## Change log

Append one row per item action. No cleanup deletion has occurred as of tracker creation.

| Date/time (Asia/Taipei) | Item ID | Action | Recovery reference | Verification | Commit/reference | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-08 | — | Tracker created; no deletion | Not created yet | Documentation only | Git history when committed | Existing local edits preserved |
