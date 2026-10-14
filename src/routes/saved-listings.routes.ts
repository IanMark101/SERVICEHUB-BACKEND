import { Router } from 'express';
import { requireAuth, requireMarketplaceUser, requireEmailVerified } from '../middlewares/auth.middleware';
import { list, status, save, remove } from '../controllers/saved-listings.controller';

const router = Router();
router.use(requireAuth, requireMarketplaceUser, requireEmailVerified);
router.get('/', list);
router.get('/status', status);
router.put('/:contentType/:listingId', save);
router.delete('/:contentType/:listingId', remove);
export default router;
