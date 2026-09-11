import type { Request, Response, NextFunction } from "express";
import type { Prisma } from "@prisma/client";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { safeBroadcast } from "../../lib/socket";
import { AnnouncementCreateSchema, AnnouncementUpdateSchema } from "../../schema/marketplace.schema";

const NOTIFICATION_BATCH_SIZE = 500;

async function notifyUsersOfPublishedAnnouncement(
  tx: Prisma.TransactionClient,
  announcement: { id: string; title: string; body: string },
) {
  let cursor: string | undefined;
  let recipientCount = 0;

  do {
    const recipients = await tx.user.findMany({
      where: { role: { not: "admin" }, isActive: true },
      select: { id: true },
      orderBy: { id: "asc" },
      take: NOTIFICATION_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (recipients.length === 0) break;

    await tx.notification.createMany({
      data: recipients.map(({ id }) => ({
        userId: id,
        title: `Official announcement: ${announcement.title}`,
        body: announcement.body,
        link: "/community-hub",
      })),
    });
    recipientCount += recipients.length;
    cursor = recipients.at(-1)?.id;
    if (recipients.length < NOTIFICATION_BATCH_SIZE) break;
  } while (cursor);

  return recipientCount;
}

export async function listAnnouncements(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const [announcements, total] = await Promise.all([
      prisma.announcement.findMany({ include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
      prisma.announcement.count(),
    ]);
    res.json({ success: true, data: announcements, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
}

export async function createAnnouncement(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as AuthenticatedRequest).user;
    const input = AnnouncementCreateSchema.parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const announcement = await tx.announcement.create({
        data: {
          title: input.title,
          body: input.body,
          authorId: admin.id,
          isPublished: input.isPublished,
          publishedAt: input.isPublished ? new Date() : null,
        },
        include: { author: { select: { id: true, name: true } } },
      });
      const recipientCount = input.isPublished
        ? await notifyUsersOfPublishedAnnouncement(tx, announcement)
        : 0;
      await tx.adminAuditLog.create({
        data: {
          actorId: admin.id,
          action: "ANNOUNCEMENT_CREATED",
          resourceType: "Announcement",
          resourceId: announcement.id,
          reason: input.isPublished ? "Published official Community Hub announcement" : "Created announcement draft",
          metadata: { recipientCount },
        },
      });
      return { announcement, recipientCount };
    });
    safeBroadcast("COMMUNITY_ANNOUNCEMENTS_CHANGED", { id: result.announcement.id });
    if (result.recipientCount > 0) {
      safeBroadcast("notification", { title: result.announcement.title, link: "/community-hub" });
    }
    res.status(201).json({ success: true, data: result.announcement });
  } catch (err) {
    next(err);
  }
}

export async function updateAnnouncement(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as AuthenticatedRequest).user;
    const input = AnnouncementUpdateSchema.parse(req.body);
    const announcementId = req.params.id as string;
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`announcement:${announcementId}`}))`;
      const existing = await tx.announcement.findUnique({ where: { id: announcementId } });
      if (!existing) {
        const error = new Error("Announcement not found") as Error & { status?: number };
        error.status = 404;
        throw error;
      }
      const becomingPublished = input.isPublished === true && !existing.isPublished;
      const announcement = await tx.announcement.update({
        where: { id: existing.id },
        data: {
          ...input,
          ...(becomingPublished && { publishedAt: new Date() }),
        },
        include: { author: { select: { id: true, name: true } } },
      });
      const recipientCount = becomingPublished
        ? await notifyUsersOfPublishedAnnouncement(tx, announcement)
        : 0;
      await tx.adminAuditLog.create({
        data: {
          actorId: admin.id,
          action: "ANNOUNCEMENT_UPDATED",
          resourceType: "Announcement",
          resourceId: announcement.id,
          reason: input.isPublished === false ? "Archived announcement" : input.isPublished === true ? "Published announcement" : "Edited announcement content",
          metadata: { ...input, recipientCount },
        },
      });
      return { announcement, recipientCount };
    });
    safeBroadcast("COMMUNITY_ANNOUNCEMENTS_CHANGED", { id: result.announcement.id });
    if (result.recipientCount > 0) {
      safeBroadcast("notification", { title: result.announcement.title, link: "/community-hub" });
    }
    res.json({ success: true, data: result.announcement });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/users ──────────────────────────────────────────────────────────
