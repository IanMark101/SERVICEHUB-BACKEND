import { Router } from 'express';
import { uploadController } from '../controllers/upload.controller';
const router = Router();
// Upload routes (publicly accessible for signup as well as profile updates)
router.post('/avatar', (req, res) => uploadController.uploadAvatar(req, res));
router.post('/image', (req, res) => uploadController.uploadImage(req, res));
export default router;
//# sourceMappingURL=upload.routes.js.map