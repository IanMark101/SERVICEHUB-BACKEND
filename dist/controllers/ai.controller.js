"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProviderSummary = getProviderSummary;
exports.matchProviders = matchProviders;
const ai_service_1 = require("../services/ai.service");
async function getProviderSummary(req, res, next) {
    try {
        const { providerId } = req.params;
        const result = await (0, ai_service_1.summarizeProviderReviews)(providerId);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function matchProviders(req, res, next) {
    try {
        const { requestId } = req.body;
        if (!requestId) {
            return res.status(400).json({ success: false, error: "Missing requestId" });
        }
        const result = await (0, ai_service_1.matchProvidersToRequest)(requestId);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=ai.controller.js.map