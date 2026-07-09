import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { getMessages, sendMessage, getConversations } from "../services/messages.service";

export async function listConversations(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const conversations = await getConversations(user.id);
    res.json({ success: true, data: conversations });
  } catch (err) {
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const bookingId = req.params.bookingId || req.params.completedServiceId;

    const messages = await getMessages(bookingId as string, user.id);
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
    const { content, imageUrl } = req.body;

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
