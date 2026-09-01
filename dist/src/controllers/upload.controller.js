import { uploadImageToCloudinary, uploadPrivateVerificationImage } from '../config/cloudinary';
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
function validateImageDataUrl(image, maxBytes = MAX_IMAGE_BYTES) {
    if (typeof image !== 'string')
        return null;
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(image);
    if (!match || !ALLOWED_IMAGE_TYPES.has(match[1].toLowerCase()))
        return null;
    const estimatedBytes = Math.floor((match[2].length * 3) / 4);
    if (estimatedBytes > maxBytes)
        return null;
    return image;
}
export class UploadController {
    async uploadVerification(req, res) {
        try {
            const validatedImage = validateImageDataUrl(req.body?.image, 5 * 1024 * 1024);
            if (!validatedImage) {
                res.status(400).json({ success: false, error: 'A JPEG, PNG, or WebP image no larger than 5MB is required.' });
                return;
            }
            const userId = req.user.id;
            const storageKey = await uploadPrivateVerificationImage(validatedImage, userId);
            res.status(201).json({ success: true, data: { storageKey } });
        }
        catch (error) {
            res.status(error?.status || 500).json({ success: false, error: error?.message || 'Verification upload failed.' });
        }
    }
    /**
     * POST /api/upload/avatar
     * Uploads a square avatar image to Cloudinary (folder: servicehub/avatars)
     */
    async uploadAvatar(req, res) {
        try {
            const { image } = req.body;
            const validatedImage = validateImageDataUrl(image);
            if (!validatedImage) {
                res.status(400).json({
                    success: false,
                    error: 'A JPEG, PNG, or WebP data URL no larger than 10MB is required.',
                });
                return;
            }
            const cdnUrl = await uploadImageToCloudinary(validatedImage, {
                folder: 'servicehub/avatars',
                width: 500,
                height: 500,
                crop: 'fill',
                gravity: 'face',
            });
            res.status(200).json({
                success: true,
                url: cdnUrl,
                message: 'Avatar uploaded successfully',
            });
        }
        catch (error) {
            console.error('[UploadController.uploadAvatar Error]:', error);
            res.status(500).json({
                success: false,
                error: error?.message || 'Failed to upload avatar image.',
            });
        }
    }
    /**
     * POST /api/upload/image
     * Uploads a general image attachment (folder: servicehub/attachments)
     */
    async uploadImage(req, res) {
        try {
            const { image } = req.body;
            const validatedImage = validateImageDataUrl(image);
            if (!validatedImage) {
                res.status(400).json({
                    success: false,
                    error: 'A JPEG, PNG, or WebP data URL no larger than 10MB is required.',
                });
                return;
            }
            const cdnUrl = await uploadImageToCloudinary(validatedImage, {
                // Folder selection is server-owned. Client-controlled folders let users
                // place untrusted content in unrelated Cloudinary namespaces.
                folder: 'servicehub/attachments',
                width: 1200,
                height: 1200,
                crop: 'limit',
            });
            res.status(200).json({
                success: true,
                url: cdnUrl,
            });
        }
        catch (error) {
            console.error('[UploadController.uploadImage Error]:', error);
            res.status(500).json({
                success: false,
                error: error?.message || 'Failed to upload image.',
            });
        }
    }
}
export const uploadController = new UploadController();
//# sourceMappingURL=upload.controller.js.map