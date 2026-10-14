const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** FileReader produces padded base64; padding is not part of the decoded photo. */
export function validateImageDataUrl(image: unknown, maxBytes = MAX_IMAGE_BYTES): string | null {
  if (typeof image !== 'string') return null;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(image);
  if (!match || !ALLOWED_IMAGE_TYPES.has(match[1].toLowerCase()) || match[2].length % 4 !== 0) return null;
  const paddingBytes = match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0;
  const decodedBytes = (match[2].length * 3) / 4 - paddingBytes;
  if (decodedBytes > maxBytes) return null;
  return image;
}
