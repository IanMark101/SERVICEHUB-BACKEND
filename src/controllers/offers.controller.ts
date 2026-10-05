import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { prisma } from "../lib/prisma";
import {
  submitOffer,
  listReceivedOffers,
  acceptOffer,
  rejectOffer,
} from "../services/offers.service";
import { OfferSchema } from "../schema/marketplace.schema";

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { requestId, serviceId, offeredPrice, estimatedDuration, availability, message } = OfferSchema.parse(req.body);

    const offer = await submitOffer(user.id, {
      requestId,
      serviceId,
      offeredPrice,
      estimatedDuration,
      availability,
      message,
    });

    res.status(201).json({ success: true, data: offer });
  } catch (err: any) {
    if (err.name === "ZodError") {
      const labels: Record<string, string> = { offeredPrice: 'Price', estimatedDuration: 'Expected duration', availability: 'Availability', message: 'Message', serviceId: 'Service listing', requestId: 'Request' };
      const issues = err.issues.map((issue: { path: string[]; message: string }) => ({ ...issue, message: `${labels[issue.path[0]] || 'Offer'}: ${issue.message}` }));
      return res.status(400).json({ success: false, code: 'OFFER_VALIDATION_FAILED', error: issues[0]?.message || 'Check your offer details.', errors: issues });
    }
    next(err);
  }
}

export async function getReceived(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const offers = await listReceivedOffers(user.id);
    res.json({ success: true, data: offers });
  } catch (err) {
    next(err);
  }
}

// ── GET /offers/mine — provider's submitted bids ───────────────────────────────
export async function getMine(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const offers = await prisma.offer.findMany({
      where: {
        providerId: user.id,
      },
      include: {
        request: {
          select: {
            id: true,
            seekerId: true,
            title: true,
            description: true,
            budgetMin: true,
            budgetMax: true,
            urgency: true,
            status: true,
            paymentMethods: true,
            preferredPaymentMethod: true,
            seeker: { select: { id: true, name: true, avatarUrl: true } },
            category: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    const decisions = await prisma.notification.findMany({ where: {
      userId: user.id,
      id: { in: offers.filter(offer => offer.status === 'REJECTED').flatMap(offer => [`offer-declined:${offer.id}`, `offer-not-selected:${offer.id}`]) },
    }, select: { id: true } });
    const decisionIds = new Set(decisions.map(item => item.id));
    res.json({ success: true, data: offers.map(offer => ({ ...offer, decisionReason:
      decisionIds.has(`offer-declined:${offer.id}`) ? 'DECLINED' : decisionIds.has(`offer-not-selected:${offer.id}`) ? 'NOT_SELECTED' : null,
    })) });
  } catch (err) {
    next(err);
  }
}

export async function accept(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const offer = await acceptOffer(req.params.id as string, user.id);
    res.json({
      success: true,
      message: "Offer accepted. Seeker must now complete payment to confirm the queue position.",
      data: offer,
    });
  } catch (err) {
    next(err);
  }
}

export async function reject(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const offer = await rejectOffer(req.params.id as string, user.id);
    res.json({ success: true, data: offer, message: offer.status === 'WITHDRAWN' ? 'Offer withdrawn' : 'Offer declined' });
  } catch (err) {
    next(err);
  }
}
