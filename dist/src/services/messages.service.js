import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";
import { assertDistinctAccounts } from "../utils/security";
export async function checkMessagingAccess(bookingId, userId, userRole) {
    const booking = await prisma.booking.findUnique({
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
    // Admin users can access any booking's messages for dispute/report investigation
    if (userRole === 'admin') {
        return booking;
    }
    // Authorization: only the seeker or provider of this booking can access
    if (booking.seekerId !== userId && booking.providerId !== userId) {
        const err = new Error("Access denied: You are not a participant in this transaction.");
        err.status = 403;
        throw err;
    }
    return booking;
}
export async function getConversations(userId) {
    const bookings = await prisma.booking.findMany({
        where: {
            OR: [
                { seekerId: userId, hiddenBySeeker: false },
                { providerId: userId, hiddenByProvider: false }
            ],
            // Only show bookings where both parties have entered an agreement
            status: { notIn: ["PENDING_APPROVAL", "DECLINED"] }
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
                include: { sender: { select: { id: true, name: true, avatarUrl: true } } }
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
        const lastMsgObj = b.messages?.[0];
        let lastMessage = undefined;
        if (lastMsgObj) {
            if (lastMsgObj.isSystem) {
                lastMessage = lastMsgObj.content;
            }
            else {
                const senderName = lastMsgObj.sender?.name || (lastMsgObj.senderId === userId ? "You" : "User");
                lastMessage = `${senderName}: ${lastMsgObj.content || "📷 Image"}`;
            }
        }
        const otherPartyId = otherParty?.id || (isSeeker ? b.providerId : b.seekerId) || "";
        const otherPartyName = otherParty?.name || (isSeeker ? "Provider" : "Seeker");
        const otherPartyAvatar = otherParty?.avatarUrl || null;
        return {
            bookingId: b.id,
            title,
            otherPartyId,
            otherPartyName,
            otherPartyAvatar,
            otherPartyRole,
            status: b.status,
            lastMessage,
            lastMessageTime: lastMsgObj ? lastMsgObj.createdAt : b.updatedAt,
            unreadCount: b._count?.messages || 0
        };
    });
}
export async function getMessages(bookingId, userId, userRole) {
    // Validate basic access (seeker or provider check, admin bypass)
    await checkMessagingAccess(bookingId, userId, userRole);
    // Only mark messages as read if the user is a participant (not admin viewing)
    if (userRole !== 'admin') {
        await prisma.message.updateMany({
            where: {
                bookingId,
                receiverId: userId,
                isRead: false,
            },
            data: { isRead: true },
        });
        // Auto mark matching notification alerts as read
        await prisma.notification.updateMany({
            where: {
                userId,
                isRead: false,
                OR: [
                    { link: `/seeker/seeker-activity?booking=${bookingId}` },
                    { link: `/provider/provider-activity?booking=${bookingId}` },
                    // Legacy links for backwards compatibility
                    { link: `/seeker/messages?booking=${bookingId}` },
                    { link: `/provider/messages?booking=${bookingId}` }
                ]
            },
            data: { isRead: true }
        });
    }
    return prisma.message.findMany({
        where: { bookingId },
        include: {
            sender: { select: { id: true, name: true, avatarUrl: true } },
        },
        orderBy: { createdAt: "asc" },
    });
}
/**
 * Admin-only: Get all messages for a specific booking (for dispute/report investigation).
 * Returns booking context + full message history.
 */
export async function getBookingMessagesForAdmin(bookingId) {
    const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
            seeker: { select: { id: true, name: true, avatarUrl: true, email: true } },
            provider: { select: { id: true, name: true, avatarUrl: true, email: true } },
            service: { select: { title: true } },
            offer: { include: { request: { select: { title: true } } } },
            directRequest: { include: { service: { select: { title: true } } } },
            messages: {
                include: {
                    sender: { select: { id: true, name: true, avatarUrl: true } },
                },
                orderBy: { createdAt: "asc" },
            },
        },
    });
    if (!booking) {
        const err = new Error("Booking not found");
        err.status = 404;
        throw err;
    }
    const title = booking.service?.title || booking.offer?.request?.title || booking.directRequest?.service?.title || "Job Engagement";
    return {
        bookingId: booking.id,
        status: booking.status,
        title,
        seeker: booking.seeker,
        provider: booking.provider,
        messages: booking.messages,
        messageCount: booking.messages.length,
    };
}
export async function sendMessage(bookingId, senderId, content, imageUrl, isSystem = false) {
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
    assertDistinctAccounts(senderId, receiverId, "send message");
    const message = await prisma.message.create({
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
    await prisma.message.updateMany({
        where: {
            bookingId,
            receiverId: senderId,
            isRead: false,
        },
        data: { isRead: true },
    });
    // ── Real-time: broadcast to booking room ─────────────────────────────────
    safeEmit(`booking:${bookingId}`, "new_message", message);
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
    safeEmit(`user:${receiverId}`, "message_notification", {
        bookingId,
        senderId,
        senderName: message.sender.name,
        preview: content?.slice(0, 60) || "📷 Image",
    });
    return message;
}
//# sourceMappingURL=messages.service.js.map