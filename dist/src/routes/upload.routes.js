import { Router } from 'express';
import { uploadController } from '../controllers/upload.controller';
import { requireAuth, requireMarketplaceUser } from '../middlewares/auth.middleware';
import { uploadLimiter } from '../middlewares/rateLimiter.middleware';
const router = Router();
// Media is stored using the application's Cloudinary credentials. Do not expose
// this capability to anonymous callers; signup can proceed without an avatar and
// the user can upload one after authentication.
router.use(requireAuth, requireMarketplaceUser);
router.post('/avatar', uploadLimiter, (req, res) => uploadController.uploadAvatar(req, res));
router.post('/image', uploadLimiter, (req, res) => uploadController.uploadImage(req, res));
router.post('/verification', uploadLimiter, (req, res) => uploadController.uploadVerification(req, res));
export default router;
//# sourceMappingURL=upload.routes.js.map