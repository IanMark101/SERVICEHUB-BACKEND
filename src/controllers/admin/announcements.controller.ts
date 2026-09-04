import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { safeBroadcast } from "../../lib/socket";
import { AnnouncementCreateSchema, AnnouncementUpdateSchema } from "../../schema/marketplace.schema";

export async function listAnnouncements(_req: Request, res: Response, next: NextFunction) {
  try {
    const announcements = await prisma.announcement.findMany({
      include: { author: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ success: true, data: announcements });
  } catch (err) {
    next(err);
  }
}

export async function createAnnouncement(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as AuthenticatedRequest).user;
    const input = AnnouncementCreateSchema.parse(req.body);
    const announcement = await prisma.announcement.create({
      data: {
        title: input.title,
        body: input.body,
        authorId: admin.id,
        isPublished: input.isPublished,
        publishedAt: input.isPublished ? new Date() : null,
      },
      include: { author: { select: { id: true, name: true } } },
    });
    await prisma.adminAuditLog.create({
      data: {
        actorId: admin.id,
        action: "ANNOUNCEMENT_CREATED",
        resourceType: "Announcement",
        resourceId: announcement.id,
        reason: input.isPublished ? "Published official Community Hub announcement" : "Created announcement draft",
      },
    });
    safeBroadcast("COMMUNITY_ANNOUNCEMENTS_CHANGED", { id: announcement.id });
    res.status(201).json({ success: true, data: announcement });
  } catch (err) {
    next(err);
  }
}

export async function updateAnnouncement(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as AuthenticatedRequest).user;
    const input = AnnouncementUpdateSchema.parse(req.body);
    const existing = await prisma.announcement.findUnique({ where: { id: req.params.id as string } });
    if (!existing) {
      return res.status(404).json({ success: false, error: "Announcement not found" });
    }

    const becomingPublished = input.isPublished === true && !existing.isPublished;
    const announcement = await prisma.announcement.update({
      where: { id: existing.id },
      data: {
        ...input,
        ...(becomingPublished && { publishedAt: new Date() }),
      },
      include: { author: { select: { id: true, name: true } } },
    });
    await prisma.adminAuditLog.create({
      data: {
        actorId: admin.id,
        action: "ANNOUNCEMENT_UPDATED",
        resourceType: "Announcement",
        resourceId: announcement.id,
        reason: input.isPublished === false ? "Archived announcement" : input.isPublished === true ? "Published announcement" : "Edited announcement content",
        metadata: input,
      },
    });
    safeBroadcast("COMMUNITY_ANNOUNCEMENTS_CHANGED", { id: announcement.id });
    res.json({ success: true, data: announcement });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/users ──────────────────────────────────────────────────────────
