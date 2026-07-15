import { submitVerification, getVerificationStatus, listPendingVerifications, reviewVerification, } from "../services/verification.service";
// ── POST /verifications/submit ────────────────────────────────────────────────
export async function submit(req, res, next) {
    try {
        const user = req.user;
        const { proofs } = req.body;
        const verification = await submitVerification(user.id, proofs || []);
        res.status(201).json({ success: true, data: verification });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /verifications/status ──────────────────────────────────────────────────
export async function getStatus(req, res, next) {
    try {
        const user = req.user;
        const status = await getVerificationStatus(user.id);
        res.json({ success: true, data: status });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /admin/verifications ───────────────────────────────────────────────────
export async function adminList(req, res, next) {
    try {
        const list = await listPendingVerifications();
        res.json({ success: true, data: list });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /admin/verifications/:id ────────────────────────────────────────────
export async function adminReview(req, res, next) {
    try {
        const admin = req.user;
        const { id } = req.params;
        const { approve, adminNotes } = req.body;
        const result = await reviewVerification(id, admin.id, approve, adminNotes);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=verification.controller.js.map