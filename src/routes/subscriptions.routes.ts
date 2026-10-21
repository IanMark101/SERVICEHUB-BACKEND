import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireMarketplaceUser, requireEmailVerified, requireVerification, type AuthenticatedRequest } from '../middlewares/auth.middleware';
import { subscriptionCheckoutLimiter, subscriptionConfirmationLimiter } from '../middlewares/rateLimiter.middleware';
import { cancelProviderSubscription, cancelSubscriptionCheckout, getProviderSubscription, reconcileSubscriptionPayment, startSubscriptionCheckout } from '../services/subscriptions.service';

const router = Router();
const intentInput = z.object({ paymentIntentId: z.string().regex(/^pi_[a-zA-Z0-9]+$/).max(150) }).strict();
const emptyInput = z.object({}).strict();
// Shared marketplace accounts may switch workspaces; administrators cannot subscribe.
router.use(requireAuth, requireMarketplaceUser, requireEmailVerified);
router.get('/', async (req, res, next) => {
  try { res.json({ success: true, data: await getProviderSubscription((req as AuthenticatedRequest).user.id) }); } catch (error) { next(error); }
});
router.post('/checkout', requireVerification, subscriptionCheckoutLimiter, async (req, res, next) => {
  try { emptyInput.parse(req.body); res.json({ success: true, data: await startSubscriptionCheckout((req as AuthenticatedRequest).user.id) }); } catch (error) { next(error); }
});
router.post('/confirm', subscriptionConfirmationLimiter, async (req, res, next) => {
  try { const input = intentInput.parse(req.body); res.json({ success: true, data: await reconcileSubscriptionPayment((req as AuthenticatedRequest).user.id, input.paymentIntentId) }); } catch (error) { next(error); }
});
router.post('/checkout/cancel', subscriptionCheckoutLimiter, async (req, res, next) => {
  try { const input = intentInput.parse(req.body); res.json({ success: true, data: await cancelSubscriptionCheckout((req as AuthenticatedRequest).user.id, input.paymentIntentId) }); } catch (error) { next(error); }
});
router.post('/cancel', subscriptionCheckoutLimiter, async (req, res, next) => {
  try { emptyInput.parse(req.body); res.json({ success: true, data: await cancelProviderSubscription((req as AuthenticatedRequest).user.id) }); } catch (error) { next(error); }
});
export default router;
