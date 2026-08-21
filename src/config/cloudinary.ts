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
  console.warn('[Cloudinary] Credentials not provided in .env. Uploads will use fallback mode.');
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

  // If Cloudinary is not configured, fall back gracefully
  if (!isConfigured) {
    console.log('[Cloudinary Fallback] Returning image directly (Add Cloudinary keys to .env for production CDN storage)');
    return fileData;
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

export default cloudinary;
