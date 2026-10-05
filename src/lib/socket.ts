import { Server as SocketIOServer, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "./prisma";

let io: SocketIOServer | null = null;

function socketAuthError(code: "TOKEN_EXPIRED" | "SESSION_REVOKED" | "PERMISSION_DENIED" | "ACCOUNT_BANNED") {
  return Object.assign(new Error("Socket authentication failed"), { data: { code } });
}

/**
 * Initialize Socket.io with the HTTP server.
 * Should be called once in server.ts before app.listen().
 */
export function initSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.FRONTEND_URL,
      credentials: true,
      methods: ["GET", "POST"],
    },
  });

  // ── Auth Middleware ───────────────────────────────────────────────────────
  io.use(async (socket: Socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace("Bearer ", "");

      if (!token) {
        return next(socketAuthError("SESSION_REVOKED"));
      }
      let payload: { sub: string; role: string; sid?: string };
      try {
        payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as { sub: string; role: string; sid?: string };
      } catch (error) {
        return next(socketAuthError(error instanceof jwt.TokenExpiredError ? "TOKEN_EXPIRED" : "SESSION_REVOKED"));
      }
      // Access JWTs issued before session IDs were added can recover through
      // the still-valid refresh cookie instead of forcing a logout on deploy.
      if (!payload.sid) return next(socketAuthError("TOKEN_EXPIRED"));
      const session = await prisma.refreshToken.findUnique({ where: { id: payload.sid }, select: { userId: true, expiresAt: true } });
      if (!session || session.userId !== payload.sub || session.expiresAt <= new Date()) return next(socketAuthError("SESSION_REVOKED"));
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true, isActive: true, emailVerified: true, moderationStatus: true },
      });
      if (user?.moderationStatus === "BANNED") return next(socketAuthError("ACCOUNT_BANNED"));
      if (!user || !user.isActive || !user.emailVerified) {
        return next(socketAuthError("PERMISSION_DENIED"));
      }
      // Roles and suspension status are read from the database, not from a
      // potentially stale JWT claim.
      (socket as any).userId = user.id;
      (socket as any).role = user.role;
      (socket as any).sessionId = payload.sid;
      next();
    } catch {
      next(new Error("Socket authentication temporarily unavailable"));
    }
  });

  // ── Connection Handler ────────────────────────────────────────────────────
  io.on("connection", (socket: Socket) => {
    const userId = (socket as any).userId as string;
    console.log(`[Socket.io] User connected: ${userId}`);

    // Each user joins their own personal room so they can receive targeted events
    socket.join(`user:${userId}`);
    socket.join(`session:${(socket as any).sessionId}`);

    // Admin users join the global admin room for real-time moderation alerts
    const role = (socket as any).role as string;
    if (role === "admin") {
      socket.join("admin");
      console.log(`[Socket.io] Admin ${userId} joined room: admin`);
    }

    // Join a booking chat room on demand
    socket.on("join_booking", async (bookingId: string, acknowledge?: (result: { ok: boolean; error?: string }) => void) => {
      if (typeof bookingId !== "string" || bookingId.length > 64) {
        acknowledge?.({ ok: false, error: "Invalid booking ID" });
        return;
      }
      if (socket.rooms.size >= 100) {
        acknowledge?.({ ok: false, error: "Too many active realtime subscriptions" });
        return;
      }

      try {
        const booking = await prisma.booking.findFirst({
          where: {
            id: bookingId,
            OR: [{ seekerId: userId }, { providerId: userId }],
          },
          select: { id: true },
        });
        if (!booking) {
          acknowledge?.({ ok: false, error: "Booking access denied" });
          return;
        }
        socket.join(`booking:${booking.id}`);
        acknowledge?.({ ok: true });
        console.log(`[Socket.io] ${userId} joined booking:${booking.id}`);
      } catch {
        acknowledge?.({ ok: false, error: "Unable to join booking" });
      }
    });

    // Listing viewers join a service room for provider-wide paid workload updates.
    socket.on("join_service", (serviceId: string, acknowledge?: (result: { ok: boolean; error?: string }) => void) => {
      if (typeof serviceId !== "string" || !/^[a-z0-9_-]{10,64}$/i.test(serviceId)) {
        acknowledge?.({ ok: false, error: "Invalid service ID" });
        return;
      }
      if (socket.rooms.size >= 100) {
        acknowledge?.({ ok: false, error: "Too many active realtime subscriptions" });
        return;
      }
      socket.join(`service:${serviceId}`);
      acknowledge?.({ ok: true });
    });

    socket.on("disconnect", () => {
      console.log(`[Socket.io] User disconnected: ${userId}`);
    });
  });

  console.log("✅ Socket.io initialized");
  return io;
}

/**
 * Get the global Socket.io server instance.
 * Throws if initSocket() has not been called yet.
 */
export function getIO(): SocketIOServer {
  if (!io) {
    throw new Error("Socket.io has not been initialized. Call initSocket() first.");
  }
  return io;
}

/**
 * Safely emit to a room — no-ops if socket is not initialized.
 */
export function safeEmit(room: string, event: string, data: unknown): void {
  try {
    getIO().to(room).emit(event, data);
  } catch {
    // Socket not initialized (e.g., during testing) — silently skip
  }
}

/**
 * Safely broadcast to all connected clients.
 */
export function safeBroadcast(event: string, data: unknown): void {
  try {
    getIO().emit(event, data);
  } catch {
    // Socket not initialized — silently skip
  }
}

/** Notify and immediately disconnect every active socket for a moderated user. */
export async function disconnectUserSockets(userId: string, reason: string, code?: "ACCOUNT_BANNED" | "ACCOUNT_DELETED" | "PASSWORD_CHANGED"): Promise<void> {
  if (!io) return;
  try {
    const room = `user:${userId}`;
    io.to(room).emit("forceLogout", { reason, code });
    // Give the client a brief chance to receive the account notice before
    // closing the transport. HTTP and socket guards enforce the state meanwhile.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    const sockets = await io.in(room).fetchSockets();
    sockets.forEach((socket) => socket.disconnect(true));
  } catch (error) {
    // The account state is already committed. The HTTP/socket auth guards still
    // deny future activity if a transport disconnect fails temporarily.
    console.error("[Socket.io] Unable to disconnect moderated account", error);
  }
}

export async function disconnectOtherUserSessions(userId: string, currentSessionId: string): Promise<void> {
  if (!io) return;
  try {
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    for (const socket of sockets) {
      if (socket.rooms.has(`session:${currentSessionId}`)) continue;
      socket.emit("forceLogout", { reason: "Your account security changed. Sign in again." });
      socket.disconnect(true);
    }
  } catch (error) { console.error("[Socket.io] Unable to disconnect revoked sessions", error); }
}

export async function disconnectSessionSockets(sessionId: string, reason: string): Promise<void> {
  if (!io) return;
  const room = `session:${sessionId}`;
  io.to(room).emit("forceLogout", { reason });
  const sockets = await io.in(room).fetchSockets();
  sockets.forEach((socket) => socket.disconnect(true));
}
