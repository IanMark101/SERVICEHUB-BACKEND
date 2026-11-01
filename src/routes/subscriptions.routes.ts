import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireMarketplaceUser, requireEmailVerified, requireVerification, type AuthenticatedRequest } from '../middlewares/auth.middleware';
import { subscriptionCheckoutLimiter, subscriptionConfirmationLimiter } from '../middlewares/rateLimiter.middleware';
import { cancelProviderSubscription, cancelSubscriptionCheckout, enrollProviderMembership, getProviderSubscription, quoteProviderMembership, reconcileSubscriptionPayment, startSubscriptionCheckout } from '../services/subscriptions.service';
import { PROVIDER_PLANS } from '../services/subscription-policy';

const router = Router();
const intentInput = z.object({ paymentIntentId: z.string().regex(/^pi_[a-zA-Z0-9]+$/).max(150) }).strict();
const emptyInput = z.object({}).strict();
const planInput = z.object({ plan: z.enum(['BASIC', 'PRO']) }).strict();
const checkoutInput = planInput.extend({ quoteToken: z.string().min(20).max(2000) });
router.get('/plans', (_req, res) => res.json({ success: true, data: PROVIDER_PLANS }));
// Shared marketplace accounts may switch workspaces; administrators cannot subscribe.
router.use(requireAuth, requireMarketplaceUser, requireEmailVerified);
router.get('/', async (req, res, next) => {
  try { res.json({ success: true, data: await getProviderSubscription((req as AuthenticatedRequest).user.id) }); } catch (error) { next(error); }
});
router.post('/start-free', subscriptionCheckoutLimiter, async (req, res, next) => {
  try { z.object({ providerIntent: z.literal(true) }).strict().parse(req.body); res.json({ success: true, data: await enrollProviderMembership((req as AuthenticatedRequest).user.id) }); } catch (error) { next(error); }
});
router.post('/quote', requireVerification, subscriptionCheckoutLimiter, async (req, res, next) => {
  try { const input = planInput.parse(req.body); res.json({ success: true, data: await quoteProviderMembership((req as AuthenticatedRequest).user.id, input.plan) }); } catch (error) { next(error); }
});
router.post('/checkout', requireVerification, subscriptionCheckoutLimiter, async (req, res, next) => {
  try { const input = checkoutInput.parse(req.body); res.json({ success: true, data: await startSubscriptionCheckout((req as AuthenticatedRequest).user.id, input.plan, input.quoteToken) }); } catch (error) { next(error); }
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
