export const listingPhotosInclude = {
  photos: { orderBy: { position: 'asc' }, select: { photo: { select: { id: true, url: true, width: true, height: true } } } },
} as const;

export function withListingPhotos<T extends { photos?: unknown }>(record: T) {
  const { photos, ...rest } = record;
  return { ...rest, photos: Array.isArray(photos) ? photos.map(item => item.photo) : [] };
}
