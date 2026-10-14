import { Request, Response } from 'express';
import { uploadImageToCloudinary, uploadPrivateSafetyEvidence, uploadPrivateVerificationImage } from '../config/cloudinary';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { prisma } from '../lib/prisma';
import { validateListingPhotoImage } from '../schema/listing-photos.schema';
import { uploadListingPhoto, deleteUnusedListingPhoto } from '../services/listing-photos.service';
import { validateImageDataUrl } from '../schema/upload-image.schema';

export class UploadController {
  async uploadListingPhoto(req: Request, res: Response): Promise<void> {
    try {
      const image = validateListingPhotoImage(req.body?.image);
      if (!image) { res.status(400).json({ success: false, error: 'Choose a JPEG, PNG, or WebP photo no larger than 5 MB.' }); return; }
      const data = await uploadListingPhoto((req as AuthenticatedRequest).user.id, image);
      res.status(201).json({ success: true, data });
    } catch (cause: any) { res.status(cause?.status || 500).json({ success: false, error: cause?.message || 'Photo upload failed. Please try again.' }); }
  }

  async deleteListingPhoto(req: Request, res: Response): Promise<void> {
    try {
      await deleteUnusedListingPhoto((req as AuthenticatedRequest).user.id, req.params.id as string);
      res.json({ success: true });
    } catch (cause: any) { res.status(cause?.status || 500).json({ success: false, error: cause?.message || 'Could not remove this photo.' }); }
  }

  async uploadBookingEvidence(req: Request, res: Response): Promise<void> {
    try {
      const validatedImage = validateImageDataUrl(req.body?.image, 5 * 1024 * 1024);
      const bookingId = typeof req.body?.bookingId === 'string' ? req.body.bookingId : '';
      if (!validatedImage || !bookingId) {
        res.status(400).json({ success: false, error: 'A booking ID and JPEG, PNG, or WebP image no larger than 5MB are required.' });
        return;
      }
      const userId = (req as AuthenticatedRequest).user.id;
      const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: { seekerId: true, providerId: true, status: true } });
      const eligible = booking && [booking.seekerId, booking.providerId].includes(userId) &&
        ['ACCEPTED', 'ONGOING', 'AWAITING_CONFIRMATION', 'UNDER_REVIEW', 'DISPUTED', 'COMPLETED', 'CANCELED'].includes(booking.status);
      if (!eligible) {
        res.status(403).json({ success: false, error: 'Evidence upload is restricted to participants in an eligible booking.' });
        return;
      }
      const storageKey = await uploadPrivateSafetyEvidence(validatedImage, bookingId, userId);
      res.status(201).json({ success: true, data: { storageKey } });
    } catch (error: any) {
      res.status(error?.status || 500).json({ success: false, error: error?.message || 'Safety evidence upload failed.' });
    }
  }

  async uploadVerification(req: Request, res: Response): Promise<void> {
    try {
      const validatedImage = validateImageDataUrl(req.body?.image, 5 * 1024 * 1024);
      if (!validatedImage) {
        res.status(400).json({ success: false, error: 'A JPEG, PNG, or WebP image no larger than 5MB is required.' });
        return;
      }
      const userId = (req as AuthenticatedRequest).user.id;
      const storageKey = await uploadPrivateVerificationImage(validatedImage, userId);
      res.status(201).json({ success: true, data: { storageKey } });
    } catch (error: any) {
      res.status(error?.status || 500).json({ success: false, error: error?.message || 'Verification upload failed.' });
    }
  }

  /**
   * POST /api/upload/avatar
   * Uploads a square avatar image to Cloudinary (folder: servicehub/avatars)
   */
  async uploadAvatar(req: Request, res: Response): Promise<void> {
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
