/** Reviews received as a service seeker must never include feedback earned as a provider. */
export function getSeekerReviewStats(reviews: Array<{ targetId: string; rating: number; completedService: { seekerId: string } }>) {
  const totals = new Map<string, { sum: number; count: number }>();
  for (const review of reviews) {
    if (review.targetId !== review.completedService.seekerId) continue;
    const total = totals.get(review.targetId) ?? { sum: 0, count: 0 };
    total.sum += review.rating;
    total.count += 1;
    totals.set(review.targetId, total);
  }
  return new Map([...totals].map(([id, total]) => [id, {
    clientRating: Number((total.sum / total.count).toFixed(1)),
    clientReviewCount: total.count,
  }]));
}
