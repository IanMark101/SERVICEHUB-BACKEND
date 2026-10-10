/** Match the work being offered/requested, never just the account's name.
 * Every word must match listing content; category and radius remain AND filters.
 */
export function marketplaceSearchConditions(search?: string) {
  return (search?.trim().split(/\s+/).filter(Boolean) ?? []).map(term => ({
    OR: [
      { title: { contains: term, mode: 'insensitive' as const } },
      { description: { contains: term, mode: 'insensitive' as const } },
      { category: { name: { contains: term, mode: 'insensitive' as const } } },
    ],
  }));
}
