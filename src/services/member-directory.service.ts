import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

export function memberDirectoryWhere(search?: string): Prisma.UserWhereInput {
  return {
    role: "user", isActive: true, deactivatedAt: null, moderationStatus: "ACTIVE",
    ...(search ? { OR: [
      { name: { contains: search, mode: "insensitive" as const } },
      { location: { contains: search, mode: "insensitive" as const } },
      { bio: { contains: search, mode: "insensitive" as const } },
    ] } : {}),
  };
}

// An administrator can still open their own account settings. Other admin
// profiles belong to the protected admin workspace, never the member directory.
export function memberProfileWhere(userId: string, viewerId?: string): Prisma.UserWhereUniqueInput {
  return { id: userId, ...(viewerId === userId ? {} : { role: "user" }) };
}

export async function assertMemberProfile(userId: string) {
  const user = await prisma.user.findUnique({ where: memberProfileWhere(userId), select: { id: true } });
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
}
