import { z } from 'zod';

export const ListingPhotoIdsSchema = z.array(z.string().cuid())
  .max(3, 'You can add up to 3 photos per listing.')
  .refine(ids => new Set(ids).size === ids.length, 'Choose each photo only once.');

export function validateListingPhotoImage(image: unknown): string | null {
  if (typeof image !== 'string') return null;
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(image);
  if (!match || match[2].length > Math.ceil(5 * 1024 * 1024 / 3) * 4) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 5 * 1024 * 1024 || bytes.length < 12) return null;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return (match[1].toLowerCase() === 'jpeg' ? jpeg : match[1].toLowerCase() === 'png' ? png : webp) ? image : null;
}
