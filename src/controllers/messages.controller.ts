import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { getMessages, sendMessage, getConversations, getConversationGroups, getConversationGroupForBooking, getBookingMessagesForAdmin } from "../services/messages.service";
import { MessageSchema } from "../schema/marketplace.schema";
import { prisma } from "../lib/prisma";

export async function listConversations(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const page = Math.max(1, Number.parseInt(String(req.query?.page || "1"), 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query?.limit || "20"), 10) || 20));
    const conversations = await getConversations(user.id, page, limit);
    res.json({ success: true, data: conversations.items, pagination: { page, limit, total: conversations.total, totalPages: Math.ceil(conversations.total / limit), unread: conversations.unread } });
  } catch (err) {
    next(err);
  }
}

export async function listConversationGroups(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const page = Math.max(1, Number.parseInt(String(req.query?.page || "1"), 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query?.limit || "20"), 10) || 20));
    const groups = await getConversationGroups(user.id, page, limit);
    res.json({ success: true, data: groups.items, pagination: { page, limit, total: groups.total, totalPages: Math.ceil(groups.total / limit) } });
  } catch (err) {
    next(err);
  }
}

export async function showConversationGroupForBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const group = await getConversationGroupForBooking(user.id, String(req.params.bookingId));
    if (!group) return res.status(404).json({ success: false, error: "Conversation not found" });
    res.json({ success: true, data: group });
  } catch (err) {
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const bookingId = req.params.bookingId || req.params.completedServiceId;

    const messages = await getMessages(bookingId as string, user.id, user.role);
    res.json({ success: true, data: messages });
  } catch (err: any) {
    if (err.code === "MESSAGES_LOCKED") {
      return res.status(403).json({
        success: false,
        error: err.message,
        code: err.code,
      });
    }
    next(err);
  }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const bookingId = req.params.bookingId || req.params.completedServiceId;
    const { content = "", imageUrl } = MessageSchema.parse(req.body);

    const message = await sendMessage(bookingId as string, user.id, content, imageUrl);
    res.status(201).json({ success: true, data: message });
  } catch (err: any) {
    if (err.code === "MESSAGES_LOCKED") {
      return res.status(403).json({
        success: false,
        error: err.message,
        code: err.code,
      });
    }
    next(err);
  }
}

/**
 * Admin-only: View all messages for a specific booking (dispute/report investigation).
 */
export async function adminViewMessages(req: Request, res: Response, next: NextFunction) {
  try {
    const bookingId = req.params.bookingId as string;
    const data = await getBookingMessagesForAdmin(bookingId);
    await prisma.adminAuditLog.create({ data: { actorId: (req as AuthenticatedRequest).user.id, action: "BOOKING_MESSAGES_VIEWED", resourceType: "Booking", resourceId: bookingId, reason: "Administrator reviewed the booking-specific conversation" } });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

