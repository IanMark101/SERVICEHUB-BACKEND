import { prisma } from '../lib/prisma';
import { publicLocation } from '../lib/proximity';
import { browseServices, PUBLIC_SERVICE_WHERE } from './services.service';
import { listRequests, publicRequestWhere } from './requests.service';
import { assertActiveMarketplaceAccount, lockAccountLifecycle } from './account-lifecycle.service';
import type { SavedListingType } from '../schema/saved-listings.schema';

function targetWhere(contentType: SavedListingType) {
  return contentType === 'SERVICE_LISTING' ? { serviceId: { not: null } } : { requestId: { not: null } };
}

export async function getSavedListingStatus(userId: string, contentType: SavedListingType, ids: string[]) {
  const rows = await prisma.savedListing.findMany({ where: {
    userId, ...(contentType === 'SERVICE_LISTING' ? { serviceId: { in: ids } } : { requestId: { in: ids } }),
  }, select: { serviceId: true, requestId: true } });
  return rows.map(row => (row.serviceId || row.requestId)!);
}

export async function saveListing(userId: string, contentType: SavedListingType, listingId: string) {
  return prisma.$transaction(async tx => {
    // Lock users in the same order used by marketplace/account lifecycle writes.
    const owner = contentType === 'SERVICE_LISTING'
      ? (await tx.service.findUnique({ where: { id: listingId }, select: { providerId: true } }))?.providerId
      : (await tx.serviceRequest.findUnique({ where: { id: listingId }, select: { seekerId: true } }))?.seekerId;
    if (!owner) throw Object.assign(new Error('This listing is no longer available.'), { status: 404 });
    if (owner === userId) throw Object.assign(new Error('You cannot save your own listing.'), { status: 409 });
    await lockAccountLifecycle(tx, userId, owner);
    await assertActiveMarketplaceAccount(tx, userId);
    const visible = contentType === 'SERVICE_LISTING'
      ? await tx.service.findFirst({ where: { id: listingId, ...PUBLIC_SERVICE_WHERE }, select: { id: true } })
      : await tx.serviceRequest.findFirst({ where: { id: listingId, ...publicRequestWhere() }, select: { id: true } });
    if (!visible) throw Object.assign(new Error('This listing is no longer available.'), { status: 404 });
    return contentType === 'SERVICE_LISTING'
      ? tx.savedListing.upsert({ where: { userId_serviceId: { userId, serviceId: listingId } }, update: {}, create: { userId, serviceId: listingId } })
      : tx.savedListing.upsert({ where: { userId_requestId: { userId, requestId: listingId } }, update: {}, create: { userId, requestId: listingId } });
  });
}

export async function unsaveListing(userId: string, contentType: SavedListingType, listingId: string) {
  await prisma.savedListing.deleteMany({ where: { userId, ...(contentType === 'SERVICE_LISTING' ? { serviceId: listingId } : { requestId: listingId }) } });
}

export async function getSavedListings(userId: string, contentType: SavedListingType, page: number, limit: number) {
  const where = { userId, ...targetWhere(contentType) };
  const total = await prisma.savedListing.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const resolvedPage = Math.min(page, totalPages);
  const rows = await prisma.savedListing.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (resolvedPage - 1) * limit, take: limit });
  const ids = rows.map(row => (row.serviceId || row.requestId)!);
  // Use the original listing hydration and visibility rules. Unavailable content
  // stays removable, but its text/photos/private location are never disclosed.
  const listings = !ids.length ? [] : contentType === 'SERVICE_LISTING'
    ? (await browseServices({ ids })).map(publicLocation)
    : (await listRequests(undefined, undefined, undefined, ids)).map(publicLocation);
  const byId = new Map(listings.map(listing => [listing.id, listing]));
  return {
    items: rows.map(row => ({ id: row.id, listingId: (row.serviceId || row.requestId)!, contentType, savedAt: row.createdAt, listing: byId.get((row.serviceId || row.requestId)!) ?? null })),
    pagination: { page: resolvedPage, limit, total, totalPages },
  };
}
