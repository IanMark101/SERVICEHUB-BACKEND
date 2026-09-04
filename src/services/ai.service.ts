import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";

type ProviderSummaryResult = {
  summary: string | null;
  reason?: string;
  cached: boolean;
  source: "gemini" | "computed" | "empty";
  refreshing?: boolean;
};

type ReviewForSummary = {
  id: string;
  rating: number;
  text: string | null;
  tags: unknown;
};

const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;
const summaryCache = new Map<string, {
  fingerprint: string;
  expiresAt: number;
  result: ProviderSummaryResult;
}>();
const summaryRequests = new Map<string, Promise<ProviderSummaryResult>>();
const latestFingerprints = new Map<string, string>();

function reviewFingerprint(reviews: ReviewForSummary[]) {
  return createHash("sha256")
    .update(JSON.stringify(reviews))
    .digest("base64url");
}

function computedReviewSummary(reviews: ReviewForSummary[]): ProviderSummaryResult {
  const average = reviews.reduce((total, review) => total + review.rating, 0) / reviews.length;
  const tagCounts = new Map<string, number>();

  for (const review of reviews) {
    if (!Array.isArray(review.tags)) continue;
    for (const tag of review.tags) {
      if (typeof tag !== "string" || !tag.trim()) continue;
      const cleanTag = tag.trim();
      tagCounts.set(cleanTag, (tagCounts.get(cleanTag) || 0) + 1);
    }
  }

  const highlights = [...tagCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([tag]) => tag);
  const highlightText = highlights.length
    ? ` Common strengths mentioned are ${highlights.join(", ")}.`
    : " Client feedback indicates consistent service quality and satisfaction.";

  return {
    summary: `Based on ${reviews.length} client ${reviews.length === 1 ? "review" : "reviews"}, this provider has an average rating of ${average.toFixed(1)}/5.${highlightText}`,
    cached: false,
    source: "computed",
  };
}

async function generateProviderSummary(
  providerId: string,
  fingerprint: string,
  reviews: ReviewForSummary[],
): Promise<ProviderSummaryResult> {
  let result = computedReviewSummary(reviews);
  const reviewTexts = reviews
    .filter((review) => review.text?.trim())
    .map((review) => `Rating: ${review.rating}/5 — "${review.text!.trim()}"`)
    .join("\n");

  if (env.GEMINI_API_KEY && reviewTexts) {
    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_SUMMARY_MODEL)}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `Summarize these service reviews in no more than 45 words. Be factual, professional, and mention only trends supported by the reviews:\n\n${reviewTexts}`,
              }],
            }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 90,
            },
          }),
        },
      );

      if (geminiRes.ok) {
        const geminiData = (await geminiRes.json()) as any;
        const summary = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (summary) result = { summary, cached: false, source: "gemini" };
      } else {
        console.warn(`[AI Service] Summary request returned ${geminiRes.status}; using computed digest`);
      }
    } catch (err: any) {
      console.warn("[AI Service] Summary generation timed out or failed; using computed digest", err?.message);
    }
  }

  // A review may be created or edited while Gemini is responding. Do not let
  // that older response replace the digest for the newer review fingerprint.
  if (latestFingerprints.get(providerId) === fingerprint) {
    summaryCache.set(providerId, {
      fingerprint,
      expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS,
      result,
    });
  }

  return result;
}

export function invalidateProviderSummary(providerId: string) {
  summaryCache.delete(providerId);
  latestFingerprints.delete(providerId);
}

export async function summarizeProviderReviews(providerId: string, serviceId?: string, preferFast = false) {
  try {
    // Summaries are provider-wide today. Keep the optional argument compatible
    // with the route while avoiding separate cache entries for identical data.
    void serviceId;

    // All in-app review mutations invalidate this entry. Checking memory first
    // avoids even the remote database round trip for the common modal reopen.
    const freshCached = summaryCache.get(providerId);
    if (freshCached && freshCached.expiresAt > Date.now()) {
      return { ...freshCached.result, cached: true };
    }

    let reviews: ReviewForSummary[] = [];
    try {
      reviews = await prisma.review.findMany({
        where: { targetId: providerId },
        select: { id: true, rating: true, text: true, tags: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
    } catch {
      reviews = [];
    }

    if (reviews.length === 0) {
      return {
        summary: null,
        reason: "No client reviews are available yet for this service offer.",
        cached: true,
        source: "empty" as const,
      };
    }

    const fingerprint = reviewFingerprint(reviews);
    latestFingerprints.set(providerId, fingerprint);
    const cached = summaryCache.get(providerId);
    if (cached && cached.fingerprint === fingerprint && cached.expiresAt > Date.now()) {
      return { ...cached.result, cached: true };
    }

    const requestKey = `${providerId}:${fingerprint}`;
    const existingRequest = summaryRequests.get(requestKey);
    if (existingRequest) {
      if (preferFast) {
        return {
          ...computedReviewSummary(reviews),
          refreshing: true,
        };
      }
      return existingRequest;
    }

    const request = generateProviderSummary(providerId, fingerprint, reviews)
      .finally(() => summaryRequests.delete(requestKey));
    summaryRequests.set(requestKey, request);
    if (preferFast && env.GEMINI_API_KEY && reviews.some((review) => review.text?.trim())) {
      return {
        ...computedReviewSummary(reviews),
        refreshing: true,
      };
    }
    return request;
  } catch (err: any) {
    console.error("[AI Service Safe Fallback]", err);
    return {
      summary: null,
      reason: "No client reviews are available yet for this service offer.",
      cached: false,
      source: "empty" as const,
    };
  }
}

export async function matchProvidersToRequest(requestId: string, seekerId: string) {
  try {
    const request = await prisma.serviceRequest.findUnique({
      where: { id: requestId, seekerId },
      include: { category: true },
    });

    if (!request) {
      return { suggestions: [], reason: "Request not found or access denied" };
    }

    if (!env.GEMINI_API_KEY) {
      return { suggestions: [], reason: "AI not configured" };
    }

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

    const providerList = providers.map((provider) =>
      `Provider: ${provider.provider.name} | Trust: ${provider.provider.trustScore} | Service: ${provider.title} | Price: ₱${provider.price}`,
    ).join("\n");

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `A seeker posted this request: "${request.title}" - "${request.description}" with budget ₱${request.budgetMin}-₱${request.budgetMax}.\n\nHere are available providers:\n${providerList}\n\nRank the top 3 most suitable providers for this request and give a one-line rationale for each. Format as JSON array: [{"name": "...", "rationale": "..."}]`,
            }],
          }],
        }),
      },
    );

    if (!geminiRes.ok) {
      return { suggestions: [], reason: "AI service temporary busy" };
    }

    const geminiData = (await geminiRes.json()) as any;
    const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    let suggestions = [];
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) suggestions = JSON.parse(jsonMatch[0]);
    } catch {
      suggestions = [];
    }

    return { suggestions };
  } catch (err: any) {
    console.error("[AI Match Error]", err);
    return { suggestions: [] };
  }
}
