import { CreateServiceSchema, UpdateServiceSchema } from "../schema/services.schema";
import { browseServices, getServiceById, createService, updateService, toggleServiceAvailability, deleteService, getMyServices, } from "../services/services.service";
// ── GET /services — public browse ─────────────────────────────────────────────
export async function browse(req, res, next) {
    try {
        const { categoryId, search, availableOnly } = req.query;
        const user = req.user;
        const services = await browseServices({
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
export async function getOne(req, res, next) {
    try {
        const service = await getServiceById(req.params.id);
        res.json({ success: true, data: service });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /services/mine — provider's own listings ──────────────────────────────
export async function getMine(req, res, next) {
    try {
        const user = req.user;
        const services = await getMyServices(user.id);
        res.json({ success: true, data: services });
    }
    catch (err) {
        next(err);
    }
}
// ── POST /services ─────────────────────────────────────────────────────────────
export async function create(req, res, next) {
    try {
        const user = req.user;
        const input = CreateServiceSchema.parse(req.body);
        const service = await createService(user.id, input);
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
export async function update(req, res, next) {
    try {
        const user = req.user;
        const input = UpdateServiceSchema.parse(req.body);
        const service = await updateService(req.params.id, user.id, input);
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
export async function toggle(req, res, next) {
    try {
        const user = req.user;
        const service = await toggleServiceAvailability(req.params.id, user.id);
        res.json({ success: true, data: service });
    }
    catch (err) {
        next(err);
    }
}
// ── DELETE /services/:id ───────────────────────────────────────────────────────
export async function remove(req, res, next) {
    try {
        const user = req.user;
        await deleteService(req.params.id, user.id);
        res.json({ success: true, message: "Service listing removed" });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=services.controller.js.map