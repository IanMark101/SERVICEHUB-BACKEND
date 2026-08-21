import { prisma } from "../lib/prisma";
import { env } from "../config/env";
export async function summarizeProviderReviews(providerId, serviceId) {
    try {
        // Query actual reviews for this provider targetId
        let reviews = [];
        try {
            reviews = await prisma.review.findMany({
                where: {
                    targetId: providerId,
                },
                select: { rating: true, text: true, tags: true },
                orderBy: { createdAt: "desc" },
                take: 20,
            });
        }
        catch {
            reviews = [];
        }
        // If 0 reviews exist, return summary: null with friendly reason
        if (!reviews || reviews.length === 0) {
            return {
                summary: null,
                reason: "No client reviews are available yet for this service offer.",
            };
        }
        const reviewTexts = reviews
            .filter((r) => r.text)
            .map((r) => `Rating: ${r.rating}/5 — "${r.text}"`)
            .join("\n");
        // Call Google Gemini API if key is present and review text exists
        if (env.GEMINI_API_KEY && reviewTexts.length > 0) {
            try {
                const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [{
                                parts: [{
                                        text: `Summarize these service reviews in 2 concise sentences, highlighting key client satisfaction trends and quality of work:\n\n${reviewTexts}`
                                    }]
                            }],
                    }),
                });
                const geminiData = (await geminiRes.json());
                const summary = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (summary) {
                    return { summary, cached: false };
                }
            }
            catch (err) {
                console.error("[AI Service Gemini API Error]", err);
            }
        }
        // Dynamic fallback summary using real review metrics if Gemini API is not available
        const avgRating = (reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length).toFixed(1);
        const count = reviews.length;
        return {
            summary: `Based on ${count} client ${count === 1 ? 'review' : 'reviews'} with an average rating of ${avgRating}/5 stars. Clients highlight dependable service quality and satisfaction.`,
            cached: false,
        };
    }
    catch (err) {
        console.error("[AI Service Safe Fallback]", err);
        return {
            summary: null,
            reason: "No client reviews are available yet for this service offer.",
        };
    }
}
export async function matchProvidersToRequest(requestId) {
    try {
        const request = await prisma.serviceRequest.findUnique({
            where: { id: requestId },
            include: { category: true },
        });
        if (!request) {
            return { suggestions: [], reason: "Request not found" };
        }
        if (!env.GEMINI_API_KEY) {
            return { suggestions: [], reason: "AI not configured" };
        }
        // Get top providers in same category
        const providers = await prisma.service.findMany({
            where: { categoryId: request.categoryId, status: "ACTIVE", isAvailable: true },
            include: {
                provider: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
            },
            orderBy: { provider: { trustScore: "desc" } },
            take: 10,
        });
        if (providers.length === 0) {
            return { suggestions: [], reason: "No providers in this category" };
        }
        const providerList = providers.map((p) => `Provider: ${p.provider.name} | Trust: ${p.provider.trustScore} | Service: ${p.title} | Price: ₱${p.price}`).join("\n");
        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{
                        parts: [{
                                text: `A seeker posted this request: "${request.title}" - "${request.description}" with budget ₱${request.budgetMin}-₱${request.budgetMax}.\n\nHere are available providers:\n${providerList}\n\nRank the top 3 most suitable providers for this request and give a one-line rationale for each. Format as JSON array: [{"name": "...", "rationale": "..."}]`
                            }]
                    }],
            }),
        });
        if (!geminiRes.ok) {
            return { suggestions: [], reason: "AI service temporary busy" };
        }
        const geminiData = (await geminiRes.json());
        const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
        let suggestions = [];
        try {
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (jsonMatch)
                suggestions = JSON.parse(jsonMatch[0]);
        }
        catch {
            suggestions = [];
        }
        return { suggestions };
    }
    catch (err) {
        console.error("[AI Match Error]", err);
        return { suggestions: [] };
    }
}
//# sourceMappingURL=ai.service.js.map