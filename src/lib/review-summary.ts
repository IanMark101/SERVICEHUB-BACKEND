export type ReviewContext = 'provider' | 'seeker';
export type ReviewForSummary = { id: string; rating: number; text: string | null; tags: unknown; contentVersion: number };

const TAGS: Record<ReviewContext, string[]> = {
  provider: ['Punctual', 'Skilled', 'Friendly', 'Professional', 'Great Quality', 'Fair Price', 'Efficient'],
  seeker: ['Prompt Payment', 'Respectful', 'Clear Instructions', 'Pleasant to Work With', 'Responsive', 'Accurate Job Scope'],
};

export function sanitizeReviewText(value: string) {
  return value.replace(/https?:\/\/\S+/gi, '[link removed]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email removed]')
    .replace(/(?:\+?\d[\s().-]*){10,}/g, '[phone removed]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 2000);
}

export function reviewFacts(reviews: ReviewForSummary[], context: ReviewContext) {
  const averageRating = Number((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1));
  const counts = new Map<string, number>();
  for (const review of reviews) {
    const tags = Array.isArray(review.tags) ? review.tags : [];
    // A repeated tag in one review is still one person's feedback.
    for (const tag of new Set(tags)) {
      if (typeof tag === 'string' && TAGS[context].includes(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const topTags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  const n = reviews.length;
  return {
    reviewCount: n, averageRating, reviewContext: context, reviewLimit: 20,
    summary: `Based on ${n}${n === 20 ? ' recent' : ''} ${context === 'provider' ? 'service seeker' : 'service provider'} ${n === 1 ? 'review' : 'reviews'}, this ${context === 'provider' ? 'service provider' : 'service seeker'} has an average rating of ${averageRating.toFixed(1)}/5.${topTags.length ? ` Review tags: ${topTags.map(([tag, count]) => `${tag} (${count} ${count === 1 ? 'review' : 'reviews'})`).join(', ')}.` : ''}`,
  };
}

/** Gemini selects existing excerpts; it cannot author ratings, trends or claims. */
export function writtenReviewExcerpts(reviews: ReviewForSummary[]) {
  return reviews.flatMap(review => {
    const text = sanitizeReviewText(review.text ?? '');
    if (!text) return [];
    // Preserve the original wording and visibly mark truncation.
    const excerpt = text.length > 220 ? `${text.slice(0, 220).trimEnd()}…` : text;
    return [{ reviewId: review.id, rating: review.rating, excerpt }];
  });
}

export function groundedExcerpts(modelText: string, reviews: ReviewForSummary[]): string[] | null {
  try {
    const parsed: unknown = JSON.parse(modelText);
    if (!parsed || typeof parsed !== 'object' || !('reviewIds' in parsed) || !Array.isArray(parsed.reviewIds)) return null;
    const ids: unknown[] = parsed.reviewIds;
    if (ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) return null;
    const written = writtenReviewExcerpts(reviews);
    const selected = ids.map(id => written.find(r => r.reviewId === id));
    if (selected.some(r => !r)) return null;
    const min = Math.min(...written.map(r => r.rating));
    const max = Math.max(...written.map(r => r.rating));
    // Mixed ratings must include both ends of the written feedback, not just praise.
    if (min !== max && (!selected.some(r => r!.rating === min) || !selected.some(r => r!.rating === max))) return null;
    return selected.map(r => `${r!.rating}/5: “${r!.excerpt}”`);
  } catch {
    return null;
  }
}
