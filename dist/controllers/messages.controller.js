"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.list = list;
exports.create = create;
const messages_service_1 = require("../services/messages.service");
async function list(req, res, next) {
    try {
        const user = req.user;
        const bookingId = req.params.bookingId || req.params.completedServiceId;
        const messages = await (0, messages_service_1.getMessages)(bookingId, user.id);
        res.json({ success: true, data: messages });
    }
    catch (err) {
        if (err.code === "MESSAGES_LOCKED") {
            return res.status(403).json({
                success: false,
                error: err.message,
                code: err.code,
            });
        }
        next(err);
    }
}
async function create(req, res, next) {
    try {
        const user = req.user;
        const bookingId = req.params.bookingId || req.params.completedServiceId;
        const { content, imageUrl } = req.body;
        const message = await (0, messages_service_1.sendMessage)(bookingId, user.id, content, imageUrl);
        res.status(201).json({ success: true, data: message });
    }
    catch (err) {
        if (err.code === "MESSAGES_LOCKED") {
            return res.status(403).json({
                success: false,
                error: err.message,
                code: err.code,
            });
        }
        next(err);
    }
}
//# sourceMappingURL=messages.controller.js.map