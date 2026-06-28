"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.browse = browse;
exports.getOne = getOne;
exports.getMine = getMine;
exports.create = create;
exports.update = update;
exports.toggle = toggle;
exports.remove = remove;
const services_schema_1 = require("../schema/services.schema");
const services_service_1 = require("../services/services.service");
// ── GET /services — public browse ─────────────────────────────────────────────
async function browse(req, res, next) {
    try {
        const { categoryId, search, availableOnly } = req.query;
        const services = await (0, services_service_1.browseServices)({
            categoryId: categoryId,
            search: search,
            availableOnly: availableOnly === "true",
        });
        res.json({ success: true, data: services });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /services/:id ─────────────────────────────────────────────────────────
async function getOne(req, res, next) {
    try {
        const service = await (0, services_service_1.getServiceById)(req.params.id);
        res.json({ success: true, data: service });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /services/mine — provider's own listings ──────────────────────────────
async function getMine(req, res, next) {
    try {
        const user = req.user;
        const services = await (0, services_service_1.getMyServices)(user.id);
        res.json({ success: true, data: services });
    }
    catch (err) {
        next(err);
    }
}
// ── POST /services ─────────────────────────────────────────────────────────────
async function create(req, res, next) {
    try {
        const user = req.user;
        const input = services_schema_1.CreateServiceSchema.parse(req.body);
        const service = await (0, services_service_1.createService)(user.id, input);
        res.status(201).json({
            success: true,
            message: "Service submitted for admin review. You will be notified once approved.",
            data: service,
        });
    }
    catch (err) {
        if (err.name === "ZodError") {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        next(err);
    }
}
// ── PATCH /services/:id ────────────────────────────────────────────────────────
async function update(req, res, next) {
    try {
        const user = req.user;
        const input = services_schema_1.UpdateServiceSchema.parse(req.body);
        const service = await (0, services_service_1.updateService)(req.params.id, user.id, input);
        res.json({ success: true, data: service });
    }
    catch (err) {
        if (err.name === "ZodError") {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        next(err);
    }
}
// ── PATCH /services/:id/toggle ─────────────────────────────────────────────────
async function toggle(req, res, next) {
    try {
        const user = req.user;
        const service = await (0, services_service_1.toggleServiceAvailability)(req.params.id, user.id);
        res.json({ success: true, data: service });
    }
    catch (err) {
        next(err);
    }
}
// ── DELETE /services/:id ───────────────────────────────────────────────────────
async function remove(req, res, next) {
    try {
        const user = req.user;
        await (0, services_service_1.deleteService)(req.params.id, user.id);
        res.json({ success: true, message: "Service listing removed" });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=services.controller.js.map