import { summarizeProviderReviews, matchProvidersToRequest } from "../services/ai.service";
import { AiMatchSchema } from "../schema/marketplace.schema";
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
        const { requestId } = AiMatchSchema.parse(req.body);
        const result = await matchProvidersToRequest(requestId, req.user.id);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=ai.controller.js.map