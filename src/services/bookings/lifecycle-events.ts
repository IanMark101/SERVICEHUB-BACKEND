import type { Prisma } from '@prisma/client';
import { safeEmit } from '../../lib/socket';
import { emitProviderQueueUpdates } from '../queue.service';
import { assertDistinctAccounts } from '../../utils/security';

type Participants = { id: string; seekerId: string; providerId: string };
type Notice = Pick<Prisma.NotificationUncheckedCreateInput, 'userId' | 'title' | 'body' | 'link'>;

/** Persist the notice together with the transition. A failed response must not
 * leave a changed booking without its notification or system history. */
export async function recordLifecycleNotice(
  tx: Prisma.TransactionClient,
  booking: Participants,
  notice: Notice,
  system?: { senderId: string; content: string },
) {
  if (system) assertDistinctAccounts(system.senderId,
    system.senderId === booking.seekerId ? booking.providerId : booking.seekerId, 'send message');
  await tx.notification.create({ data: notice });
  const message = system ? await tx.message.create({
    data: {
      bookingId: booking.id,
      senderId: system.senderId,
      receiverId: system.senderId === booking.seekerId ? booking.providerId : booking.seekerId,
      content: system.content,
      isSystem: true,
    },
    include: { sender: { select: { id: true, name: true, avatarUrl: true } } },
  }) : null;
  // Recording a system event is not the same as reading the conversation.
  return { notice, message };
}

/** All authoritative writes are committed before any event is published.
 * Queue audience discovery is best effort and does not delay the actor's HTTP
 * response or either participant's immediate booking update. */
export function publishLifecycleChange(
  booking: Participants,
  type: string,
  recorded: Awaited<ReturnType<typeof recordLifecycleNotice>>,
  queueChanged = false,
) {
  for (const room of new Set([`user:${booking.seekerId}`, `user:${booking.providerId}`, `booking:${booking.id}`])) {
    safeEmit(room, 'ENGAGEMENT_CHANGED', { bookingId: booking.id, type });
  }
  safeEmit(`user:${recorded.notice.userId}`, 'notification', { title: recorded.notice.title });
  if (recorded.message) {
    const message = recorded.message;
    safeEmit(`booking:${booking.id}`, 'new_message', message);
    safeEmit(`user:${message.receiverId}`, 'message_notification', {
      bookingId: booking.id, senderId: message.senderId,
      senderName: message.sender.name, preview: message.content.slice(0, 60),
    });
  }
  if (queueChanged) {
    void emitProviderQueueUpdates(booking.providerId, [booking.seekerId, booking.providerId])
      .catch(error => console.error('Queue refresh event failed', error));
  }
}
