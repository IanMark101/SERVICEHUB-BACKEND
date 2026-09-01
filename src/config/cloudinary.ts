import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

// Check if Cloudinary credentials or CLOUDINARY_URL are provided
const hasSeparateKeys = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);
const hasUrl = Boolean(process.env.CLOUDINARY_URL);

const isConfigured = hasSeparateKeys || hasUrl;

if (hasSeparateKeys) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  console.log('[Cloudinary] Configured successfully for cloud:', process.env.CLOUDINARY_CLOUD_NAME);
} else if (hasUrl) {
  cloudinary.config({
    cloudinary_url: process.env.CLOUDINARY_URL,
    secure: true,
  });
  console.log('[Cloudinary] Configured successfully via CLOUDINARY_URL');
} else {
  console.warn('[Cloudinary] Credentials not provided; upload routes are disabled.');
}

export interface UploadOptions {
  folder?: string;
  width?: number;
  height?: number;
  crop?: string;
  gravity?: string;
}

/**
 * Upload an image (Data URL, Base64, or File URL) to Cloudinary.
 * Automatically optimizes, compresses, and returns the HTTPS CDN URL.
 */
export async function uploadImageToCloudinary(
  fileData: string,
  options: UploadOptions = {}
): Promise<string> {
  const folder = options.folder || 'servicehub/avatars';
  const width = options.width || 500;
  const height = options.height || 500;
  const crop = options.crop || 'fill';
  const gravity = options.gravity || 'face';

  // Returning a browser-supplied data URL would let multi-megabyte blobs leak
  // into profiles/messages and bypass the HTTPS Cloudinary URL policy. Fail
  // closed until managed storage is configured instead.
  if (!isConfigured) {
    const error = new Error('Image uploads are unavailable because Cloudinary is not configured.') as any;
    error.status = 503;
    throw error;
  }

  try {
    const result: UploadApiResponse = await cloudinary.uploader.upload(fileData, {
      folder,
      resource_type: 'image',
      transformation: [
        {
          width,
          height,
          crop,
          gravity,
          quality: 'auto:good',
          fetch_format: 'auto',
        },
      ],
    });

    return result.secure_url;
  } catch (error: any) {
    console.error('[Cloudinary Upload Error]:', error?.message || error);
    throw new Error(error?.message || 'Failed to upload image to Cloudinary');
  }
}

export async function uploadPrivateVerificationImage(fileData: string, userId: string): Promise<string> {
  if (!isConfigured) {
    const error = new Error('Verification uploads are unavailable because Cloudinary is not configured.') as any;
    error.status = 503;
    throw error;
  }
  const result = await cloudinary.uploader.upload(fileData, {
    folder: `servicehub/verification/${userId}`,
    resource_type: 'image',
    type: 'authenticated',
    format: 'jpg',
    transformation: [{ width: 1800, height: 1800, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' }],
  });
  return `${result.public_id}.${result.format || 'jpg'}`;
}

export function getPrivateVerificationUrl(storageKey: string): string {
  const parsed = /^(.*)\.(jpe?g|png|webp)$/i.exec(storageKey);
  if (parsed) {
    return cloudinary.utils.private_download_url(parsed[1], parsed[2], {
      resource_type: 'image',
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + 5 * 60,
      attachment: false,
    });
  }
  // Backward-compatible access for proofs uploaded before format metadata was
  // embedded in the storage key. New uploads always use the expiring path.
  return cloudinary.url(storageKey, {
    secure: true,
    type: 'authenticated',
    sign_url: true,
  });
}

export async function deletePrivateVerificationImage(storageKey: string): Promise<void> {
  if (!isConfigured) return;
  const publicId = storageKey.replace(/\.(?:jpe?g|png|webp)$/i, '');
  await cloudinary.uploader.destroy(publicId, {
    resource_type: 'image',
    type: 'authenticated',
    invalidate: true,
  });
}

export default cloudinary;
