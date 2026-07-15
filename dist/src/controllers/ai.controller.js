import { summarizeProviderReviews, matchProvidersToRequest } from "../services/ai.service";
export async function getProviderSummary(req, res, next) {
    try {
        const { providerId } = req.params;
        const { serviceId } = req.query;
        const result = await summarizeProviderReviews(providerId, serviceId);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
export async function matchProviders(req, res, next) {
    try {
        const { requestId } = req.body;
        if (!requestId) {
            return res.status(400).json({ success: false, error: "Missing requestId" });
        }
        const result = await matchProvidersToRequest(requestId);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=ai.controller.js.map