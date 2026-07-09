"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.summarizeProviderReviews = summarizeProviderReviews;
exports.matchProvidersToRequest = matchProvidersToRequest;
const prisma_1 = require("../lib/prisma");
const env_1 = require("../config/env");
async function summarizeProviderReviews(providerId) {
    // Check cache first
    const cached = await prisma_1.prisma.aiReviewSummary.findUnique({ where: { providerId } });
    const reviewCount = await prisma_1.prisma.review.count({ where: { targetId: providerId } });
    // Return cached if fresh (regenerate every 5 new reviews)
    if (cached && reviewCount < cached.reviewCount + 5) {
        return { summary: cached.summary, cached: true };
    }
    // Need at least 5 reviews to generate (master prompt Section 16)
    if (reviewCount < 5) {
        return { summary: null, reason: "Provider needs at least 5 reviews for AI summary" };
    }
    if (!env_1.env.GEMINI_API_KEY) {
        return { summary: null, reason: "AI not configured" };
    }
    // Fetch all reviews
    const reviews = await prisma_1.prisma.review.findMany({
        where: { targetId: providerId },
        select: { rating: true, text: true, tags: true },
    });
    const reviewTexts = reviews
        .filter((r) => r.text)
        .map((r) => `Rating: ${r.rating}/5 — "${r.text}"`)
        .join("\n");
    // Call Gemini API
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env_1.env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{
                    parts: [{
                            text: `Summarize these service reviews in 2-3 sentences, highlighting the most common feedback, both positive and negative:\n\n${reviewTexts}`
                        }]
                }],
        }),
    });
    const geminiData = await geminiRes.json();
    const summary = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "Unable to generate summary.";
    // Cache the result
    await prisma_1.prisma.aiReviewSummary.upsert({
        where: { providerId },
        create: { providerId, summary, reviewCount },
        update: { summary, reviewCount, generatedAt: new Date() },
    });
    return { summary, cached: false };
}
async function matchProvidersToRequest(requestId) {
    const request = await prisma_1.prisma.serviceRequest.findUnique({
        where: { id: requestId },
        include: { category: true },
    });
    if (!request) {
        const err = new Error("Request not found");
        err.status = 404;
        throw err;
    }
    if (!env_1.env.GEMINI_API_KEY) {
        return { suggestions: [], reason: "AI not configured" };
    }
    // Get top providers in same category
    const providers = await prisma_1.prisma.service.findMany({
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
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env_1.env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{
                    parts: [{
                            text: `A seeker posted this request: "${request.title}" - "${request.description}" with budget ₱${request.budgetMin}-₱${request.budgetMax}.

Here are available providers:
${providerList}

Rank the top 3 most suitable providers for this request and give a one-line rationale for each. Format as JSON array: [{"name": "...", "rationale": "..."}]`
                        }]
                }],
        }),
    });
    const geminiData = await geminiRes.json();
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
//# sourceMappingURL=ai.service.js.map