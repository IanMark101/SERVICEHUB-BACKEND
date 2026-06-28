import { prisma } from "../lib/prisma";

export async function checkMessagingUnlock(bookingId: string, userId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      seekerId: true,
      providerId: true,
      paymentStatus: true,
      directRequestId: true,
      offerId: true,
      paymentMethod: true
    },
  });

  if (!booking) {
    const err = new Error("Booking not found") as any;
    err.status = 404;
    throw err;
  }

  // Authorization: only the seeker or provider of this booking can access
  if (booking.seekerId !== userId && booking.providerId !== userId) {
    const err = new Error("Access denied") as any;
    err.status = 403;
    throw err;
  }

  // Messaging unlock gate (master prompt Section 11)
  const isCashBooking = booking.paymentMethod === "On-site Cash";
  const isPaymentConfirmed = ["PAID_HELD", "RELEASED"].includes(booking.paymentStatus);

  if (!isCashBooking && !isPaymentConfirmed) {
    const err = new Error("Messages are unlocked only after payment is confirmed") as any;
    err.status = 403;
    err.code = "MESSAGES_LOCKED";
    throw err;
  }

  return booking;
}

export async function getMessages(bookingId: string, userId: string) {
  // Validate gate
  await checkMessagingUnlock(bookingId, userId);

  return prisma.message.findMany({
    where: { bookingId },
    include: {
      sender: { select: { id: true, name: true, avatarUrl: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function sendMessage(
  bookingId: string,
  senderId: string,
  content: string,
  imageUrl?: string
) {
  if (!content?.trim() && !imageUrl) {
    const err = new Error("Message content is required") as any;
    err.status = 400;
    throw err;
  }

  // Validate gate and get booking details
  const booking = await checkMessagingUnlock(bookingId, senderId);

  const receiverId = senderId === booking.seekerId ? booking.providerId : booking.seekerId;

  const message = await prisma.message.create({
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
  await prisma.message.updateMany({
    where: {
      bookingId,
      receiverId: senderId,
      isRead: false,
    },
    data: { isRead: true },
  });

  return message;
}
