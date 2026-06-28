"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.list = list;
exports.getMine = getMine;
exports.update = update;
exports.remove = remove;
const requests_service_1 = require("../services/requests.service");
async function create(req, res, next) {
    try {
        const user = req.user;
        const { categoryId, title, description, budgetMin, budgetMax, urgency } = req.body;
        if (!categoryId || !title || !description || !budgetMin || !budgetMax) {
            return res.status(400).json({ success: false, error: "Missing required fields" });
        }
        const request = await (0, requests_service_1.createRequest)(user.id, {
            categoryId,
            title,
            description,
            budgetMin: parseFloat(budgetMin),
            budgetMax: parseFloat(budgetMax),
            urgency: urgency || "medium",
        });
        res.status(201).json({ success: true, data: request });
    }
    catch (err) {
        next(err);
    }
}
async function list(req, res, next) {
    try {
        const { categoryId } = req.query;
        const requests = await (0, requests_service_1.listRequests)(categoryId);
        res.json({ success: true, data: requests });
    }
    catch (err) {
        next(err);
    }
}
async function getMine(req, res, next) {
    try {
        const user = req.user;
        const requests = await (0, requests_service_1.getMyRequests)(user.id);
        res.json({ success: true, data: requests });
    }
    catch (err) {
        next(err);
    }
}
async function update(req, res, next) {
    try {
        const user = req.user;
        const { title, description, budgetMin, budgetMax, status } = req.body;
        const request = await (0, requests_service_1.updateRequest)(req.params.id, user.id, {
            ...(title && { title }),
            ...(description && { description }),
            ...(budgetMin && { budgetMin: parseFloat(budgetMin) }),
            ...(budgetMax && { budgetMax: parseFloat(budgetMax) }),
            ...(status && { status }),
        });
        res.json({ success: true, data: request });
    }
    catch (err) {
        next(err);
    }
}
async function remove(req, res, next) {
    try {
        const user = req.user;
        await (0, requests_service_1.cancelRequest)(req.params.id, user.id);
        res.json({ success: true, message: "Request cancelled" });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=requests.controller.js.map