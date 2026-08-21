import { getMessages, sendMessage, getConversations, getBookingMessagesForAdmin } from "../services/messages.service";
export async function listConversations(req, res, next) {
    try {
        const user = req.user;
        const conversations = await getConversations(user.id);
        res.json({ success: true, data: conversations });
    }
    catch (err) {
        next(err);
    }
}
export async function list(req, res, next) {
    try {
        const user = req.user;
        const bookingId = req.params.bookingId || req.params.completedServiceId;
        const messages = await getMessages(bookingId, user.id, user.role);
        res.json({ success: true, data: messages });
    }
    catch (err) {
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
export async function create(req, res, next) {
    try {
        const user = req.user;
        const bookingId = req.params.bookingId || req.params.completedServiceId;
        const { content, imageUrl } = req.body;
        const message = await sendMessage(bookingId, user.id, content, imageUrl);
        res.status(201).json({ success: true, data: message });
    }
    catch (err) {
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
export async function adminViewMessages(req, res, next) {
    try {
        const bookingId = req.params.bookingId;
        const data = await getBookingMessagesForAdmin(bookingId);
        res.json({ success: true, data });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=messages.controller.js.map