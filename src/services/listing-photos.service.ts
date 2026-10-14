import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import cloudinary from '../config/cloudinary';
import { ListingPhotoIdsSchema } from '../schema/listing-photos.schema';
import { assertActiveMarketplaceAccount, lockAccountLifecycle } from './account-lifecycle.service';

export async function lockListingPhotos(tx: Prisma.TransactionClient, ownerId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`listing-photos:${ownerId}`}))`;
}

export async function setListingPhotos(tx: Prisma.TransactionClient, ownerId: string, photoIds: string[], target: { serviceId: string } | { requestId: string }) {
  ListingPhotoIdsSchema.parse(photoIds);
  await lockListingPhotos(tx, ownerId);
  const ownsListing = 'serviceId' in target ? await tx.service.count({ where: { id: target.serviceId, providerId: ownerId } }) : await tx.serviceRequest.count({ where: { id: target.requestId, seekerId: ownerId } });
  if (ownsListing !== 1) throw Object.assign(new Error('You can only change photos on your own listing.'), { status: 403 });
  const owned = await tx.listingPhoto.count({ where: { id: { in: photoIds }, ownerId } });
  if (owned !== photoIds.length) throw Object.assign(new Error('One of these photos is unavailable or belongs to another user. Upload it again.'), { status: 403 });
  if ('serviceId' in target) {
    await tx.serviceListingPhoto.deleteMany({ where: target });
    if (photoIds.length) await tx.serviceListingPhoto.createMany({ data: photoIds.map((photoId, position) => ({ ...target, photoId, position })) });
  } else {
    await tx.requestListingPhoto.deleteMany({ where: target });
    if (photoIds.length) await tx.requestListingPhoto.createMany({ data: photoIds.map((photoId, position) => ({ ...target, photoId, position })) });
  }
}

export async function uploadListingPhoto(ownerId: string, image: string) {
  await prisma.$transaction(async tx => { await lockAccountLifecycle(tx, ownerId); await assertActiveMarketplaceAccount(tx, ownerId); });
  if (!cloudinary.config().api_key) throw Object.assign(new Error('Photo uploads are unavailable. Please try again later.'), { status: 503 });
  const uploaded = await cloudinary.uploader.upload(image, {
    folder: 'servicehub/listing-photos', resource_type: 'image', format: 'jpg',
    transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto:good' }],
    timeout: 60_000,
  });
  try {
    return await prisma.$transaction(async tx => {
      await lockAccountLifecycle(tx, ownerId); await assertActiveMarketplaceAccount(tx, ownerId);
      return tx.listingPhoto.create({ data: { ownerId, publicId: uploaded.public_id, url: uploaded.secure_url, width: uploaded.width, height: uploaded.height }, select: { id: true, url: true, width: true, height: true } });
    });
  } catch (cause) {
    await cloudinary.uploader.destroy(uploaded.public_id, { invalidate: true }).catch(() => {});
    throw cause;
  }
}

export async function deleteUnusedListingPhoto(ownerId: string, photoId: string) {
  return prisma.$transaction(async tx => {
    await lockListingPhotos(tx, ownerId);
    const photo = await tx.listingPhoto.findFirst({ where: { id: photoId, ownerId, services: { none: {} }, requests: { none: {} } } });
    if (!photo) throw Object.assign(new Error('This photo is already saved in a listing or is unavailable.'), { status: 409 });
    if (await isReportedPhoto(tx, photo.id)) throw Object.assign(new Error('This photo is retained as evidence for a content report or appeal.'), { status: 409 });
    await cloudinary.uploader.destroy(photo.publicId, { invalidate: true });
    await tx.listingPhoto.delete({ where: { id: photo.id } });
  }, { timeout: 65_000 });
}

async function isReportedPhoto(tx: Prisma.TransactionClient, id: string) {
  return !!await tx.contentModerationCase.findFirst({ where: { contentSnapshot: { path: ['photos'], array_contains: [{ id }] } }, select: { id: true } });
}

// Keep saved photos, including those reused in a repost. Expire abandoned uploads
// after 48 hours; account-purge orphans are eligible immediately.
export async function pruneUnusedListingPhotos() {
  // Exclude saved report evidence before LIMIT, so retained photos cannot
  // occupy every cleanup slot and starve abandoned uploads behind them.
  const candidates = await prisma.$queryRaw<{ id: string; ownerId: string | null }[]>`
    SELECT p.id, p."ownerId" FROM listing_photos p
    WHERE (p."ownerId" IS NULL OR p."createdAt" < ${new Date(Date.now() - 48 * 60 * 60 * 1000)})
      AND NOT EXISTS (SELECT 1 FROM service_listing_photos s WHERE s."photoId" = p.id)
      AND NOT EXISTS (SELECT 1 FROM request_listing_photos r WHERE r."photoId" = p.id)
      AND NOT EXISTS (SELECT 1 FROM content_moderation_cases c WHERE c."contentSnapshot"->'photos' @> jsonb_build_array(jsonb_build_object('id', p.id)))
    ORDER BY p."createdAt", p.id LIMIT 50`;
  for (const candidate of candidates) {
    await prisma.$transaction(async tx => {
      if (candidate.ownerId) await lockListingPhotos(tx, candidate.ownerId);
      const photo = await tx.listingPhoto.findFirst({ where: { id: candidate.id, services: { none: {} }, requests: { none: {} } } });
      if (!photo) return;
      if (await isReportedPhoto(tx, photo.id)) return;
      await cloudinary.uploader.destroy(photo.publicId, { invalidate: true });
      await tx.listingPhoto.delete({ where: { id: photo.id } });
    }, { timeout: 65_000 });
  }
}
