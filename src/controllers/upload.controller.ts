import { Request, Response } from 'express';
import { uploadImageToCloudinary } from '../config/cloudinary';

export class UploadController {
  /**
   * POST /api/upload/avatar
   * Uploads a square avatar image to Cloudinary (folder: servicehub/avatars)
   */
  async uploadAvatar(req: Request, res: Response): Promise<void> {
    try {
      const { image } = req.body;

      if (!image || typeof image !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Image data URL or base64 string is required.',
        });
        return;
      }

      // Check max size constraint (max ~10MB)
      if (image.length > 15 * 1024 * 1024) {
        res.status(400).json({
          success: false,
          error: 'Image exceeds maximum payload size of 10MB.',
        });
        return;
      }

      const cdnUrl = await uploadImageToCloudinary(image, {
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
    } catch (error: any) {
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
  async uploadImage(req: Request, res: Response): Promise<void> {
    try {
      const { image, folder = 'servicehub/attachments' } = req.body;

      if (!image || typeof image !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Image data URL is required.',
        });
        return;
      }

      const cdnUrl = await uploadImageToCloudinary(image, {
        folder,
        width: 1200,
        height: 1200,
        crop: 'limit',
      });

      res.status(200).json({
        success: true,
        url: cdnUrl,
      });
    } catch (error: any) {
      console.error('[UploadController.uploadImage Error]:', error);
      res.status(500).json({
        success: false,
        error: error?.message || 'Failed to upload image.',
      });
    }
  }
}

export const uploadController = new UploadController();
