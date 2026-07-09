"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkMessagingAccess = checkMessagingAccess;
exports.getConversations = getConversations;
exports.getMessages = getMessages;
exports.sendMessage = sendMessage;
const prisma_1 = require("../lib/prisma");
const socket_1 = require("../lib/socket");
const security_1 = require("../utils/security");
async function checkMessagingAccess(bookingId, userId) {
    const booking = await prisma_1.prisma.booking.findUnique({
        where: { id: bookingId },
        select: {
            id: true,
            seekerId: true,
            providerId: true,
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
        const err = new Error("Access denied: You are not a participant in this transaction.");
        err.status = 403;
        throw err;
    }
    return booking;
}
async function getConversations(userId) {
    const bookings = await prisma_1.prisma.booking.findMany({
        where: {
            OR: [
                { seekerId: userId },
                { providerId: userId }
            ],
            // Exclude pending bookings
            status: { not: "PENDING_APPROVAL" }
        },
        include: {
            seeker: { select: { id: true, name: true, avatarUrl: true } },
            provider: { select: { id: true, name: true, avatarUrl: true } },
            service: { select: { title: true } },
            offer: { include: { request: { select: { title: true } } } },
            directRequest: { include: { service: { select: { title: true } } } },
            messages: {
                orderBy: { createdAt: "desc" },
                take: 1,
                include: { sender: { select: { name: true } } }
            },
            _count: {
                select: {
                    messages: {
                        where: {
                            receiverId: userId,
                            isRead: false
                        }
                    }
                }
            }
        },
        orderBy: { updatedAt: "desc" }
    });
    return bookings.map(b => {
        const isSeeker = b.seekerId === userId;
        const otherParty = isSeeker ? b.provider : b.seeker;
        const otherPartyRole = isSeeker ? "Provider" : "Seeker";
        const title = b.service?.title || b.offer?.request?.title || b.directRequest?.service?.title || "Job Engagement";
        const lastMsgObj = b.messages[0];
        let lastMessage = undefined;
        if (lastMsgObj) {
            lastMessage = lastMsgObj.isSystem
                ? lastMsgObj.content
                : `${lastMsgObj.sender.name}: ${lastMsgObj.content || "📷 Image"}`;
        }
        return {
            bookingId: b.id,
            title,
            otherPartyId: otherParty.id,
            otherPartyName: otherParty.name,
            otherPartyAvatar: otherParty.avatarUrl,
            otherPartyRole,
            status: b.status,
            lastMessage,
            lastMessageTime: lastMsgObj ? lastMsgObj.createdAt : b.updatedAt,
            unreadCount: b._count.messages
        };
    });
}
async function getMessages(bookingId, userId) {
    // Validate basic access (seeker or provider check)
    await checkMessagingAccess(bookingId, userId);
    // Mark receiver's messages as read
    await prisma_1.prisma.message.updateMany({
        where: {
            bookingId,
            receiverId: userId,
            isRead: false,
        },
        data: { isRead: true },
    });
    // Auto mark matching notification alerts as read
    await prisma_1.prisma.notification.updateMany({
        where: {
            userId,
            isRead: false,
            OR: [
                { link: `/seeker/messages?booking=${bookingId}` },
                { link: `/provider/messages?booking=${bookingId}` }
            ]
        },
        data: { isRead: true }
    });
    return prisma_1.prisma.message.findMany({
        where: { bookingId },
        include: {
            sender: { select: { id: true, name: true, avatarUrl: true } },
        },
        orderBy: { createdAt: "asc" },
    });
}
async function sendMessage(bookingId, senderId, content, imageUrl, isSystem = false) {
    if (!content?.trim() && !imageUrl) {
        const err = new Error("Message content is required");
        err.status = 400;
        throw err;
    }
    // Validate access and get booking details
    const booking = await checkMessagingAccess(bookingId, senderId);
    // Validate permissions: messaging is active only when Accepted or In Progress
    // System messages can bypass this check to log status changes.
    const allowedStatuses = ['ACCEPTED', 'WAITING', 'ONGOING', 'AWAITING_CONFIRMATION', 'DISPUTED', 'UNDER_REVIEW'];
    if (!isSystem && !allowedStatuses.includes(booking.status)) {
        const err = new Error("This conversation is read-only because the transaction has closed or is not yet active.");
        err.status = 403;
        err.code = "MESSAGES_LOCKED";
        throw err;
    }
    const receiverId = senderId === booking.seekerId ? booking.providerId : booking.seekerId;
    (0, security_1.assertDistinctAccounts)(senderId, receiverId, "send message");
    const message = await prisma_1.prisma.message.create({
        data: {
            bookingId,
            senderId,
            receiverId,
            content: content || "",
            imageUrl,
            isSystem,
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
    // Message notifications are no longer logged in database/shown in bell dropdown to avoid redundancy.
    // The badge count on the messages icon is used instead.
    // const receiverLink = receiverId === booking.seekerId
    //   ? `/seeker/messages?booking=${bookingId}`
    //   : `/provider/messages?booking=${bookingId}`;
    // await prisma.notification.create({
    //   data: {
    //     userId: receiverId,
    //     title: `New Message from ${message.sender.name}`,
    //     body: content ? (content.length > 50 ? `${content.slice(0, 50)}...` : content) : "📷 Image",
    //     link: receiverLink
    //   }
    // });
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