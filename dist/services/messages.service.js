"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkMessagingUnlock = checkMessagingUnlock;
exports.getMessages = getMessages;
exports.sendMessage = sendMessage;
const prisma_1 = require("../lib/prisma");
const socket_1 = require("../lib/socket");
async function checkMessagingUnlock(bookingId, userId) {
    const booking = await prisma_1.prisma.booking.findUnique({
        where: { id: bookingId },
        select: {
            seekerId: true,
            providerId: true,
            paymentStatus: true,
            directRequestId: true,
            offerId: true,
            paymentMethod: true,
            status: true,
        },
    });
    if (!booking) {
        const err = new Error("Booking not found");
        err.status = 404;
        throw err;
    }
    // Authorization: only the seeker or provider of this booking can access
    if (booking.seekerId !== userId && booking.providerId !== userId) {
        const err = new Error("Access denied");
        err.status = 403;
        throw err;
    }
    // Messaging unlock gate (master prompt Section 11)
    const isCashBooking = booking.paymentMethod === "On-site Cash";
    const cashUnlocked = isCashBooking && booking.status === "ACCEPTED";
    const onlineUnlocked = !isCashBooking &&
        ["PAID_HELD", "RELEASED"].includes(booking.paymentStatus) &&
        ["WAITING", "ONGOING", "AWAITING_CONFIRMATION", "DISPUTED", "COMPLETED"].includes(booking.status);
    if (!cashUnlocked && !onlineUnlocked) {
        const err = new Error("Messages unlock only after a cash booking is accepted or an online payment is confirmed");
        err.status = 403;
        err.code = "MESSAGES_LOCKED";
        throw err;
    }
    return booking;
}
async function getMessages(bookingId, userId) {
    // Validate gate
    await checkMessagingUnlock(bookingId, userId);
    return prisma_1.prisma.message.findMany({
        where: { bookingId },
        include: {
            sender: { select: { id: true, name: true, avatarUrl: true } },
        },
        orderBy: { createdAt: "asc" },
    });
}
async function sendMessage(bookingId, senderId, content, imageUrl) {
    if (!content?.trim() && !imageUrl) {
        const err = new Error("Message content is required");
        err.status = 400;
        throw err;
    }
    // Validate gate and get booking details
    const booking = await checkMessagingUnlock(bookingId, senderId);
    const receiverId = senderId === booking.seekerId ? booking.providerId : booking.seekerId;
    const message = await prisma_1.prisma.message.create({
        data: {
            bookingId,
            senderId,
            receiverId,
            content: content || "",
            imageUrl,
        },
        include: {
            sender: { select: { id: true, name: true, avatarUrl: true } },
        },
    });
    // Mark receiver's previous messages as read
    await prisma_1.prisma.message.updateMany({
        where: {
            bookingId,
            receiverId: senderId,
            isRead: false,
        },
        data: { isRead: true },
    });
    // ── Real-time: broadcast to booking room ─────────────────────────────────
    (0, socket_1.safeEmit)(`booking:${bookingId}`, "new_message", message);
    // Also ping the receiver's personal room so they can update unread badge
    (0, socket_1.safeEmit)(`user:${receiverId}`, "message_notification", {
        bookingId,
        senderId,
        senderName: message.sender.name,
        preview: content?.slice(0, 60) || "📷 Image",
    });
    return message;
}
//# sourceMappingURL=messages.service.js.map