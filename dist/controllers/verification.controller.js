"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submit = submit;
exports.getStatus = getStatus;
exports.adminList = adminList;
exports.adminReview = adminReview;
const verification_service_1 = require("../services/verification.service");
// ── POST /verifications/submit ────────────────────────────────────────────────
async function submit(req, res, next) {
    try {
        const user = req.user;
        const { proofs } = req.body;
        const verification = await (0, verification_service_1.submitVerification)(user.id, proofs || []);
        res.status(201).json({ success: true, data: verification });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /verifications/status ──────────────────────────────────────────────────
async function getStatus(req, res, next) {
    try {
        const user = req.user;
        const status = await (0, verification_service_1.getVerificationStatus)(user.id);
        res.json({ success: true, data: status });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /admin/verifications ───────────────────────────────────────────────────
async function adminList(req, res, next) {
    try {
        const list = await (0, verification_service_1.listPendingVerifications)();
        res.json({ success: true, data: list });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /admin/verifications/:id ────────────────────────────────────────────
async function adminReview(req, res, next) {
    try {
        const admin = req.user;
        const { id } = req.params;
        const { approve, adminNotes } = req.body;
        const result = await (0, verification_service_1.reviewVerification)(id, admin.id, approve, adminNotes);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=verification.controller.js.map