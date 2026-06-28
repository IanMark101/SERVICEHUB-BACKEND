import { Server as SocketIOServer, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

let io: SocketIOServer | null = null;

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
  io.use((socket: Socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace("Bearer ", "");

      if (!token) {
        return next(new Error("Authentication error: no token provided"));
      }

      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as { userId: string; role: string };
      (socket as any).userId = payload.userId;
      (socket as any).role = payload.role;
      next();
    } catch {
      next(new Error("Authentication error: invalid token"));
    }
  });

  // ── Connection Handler ────────────────────────────────────────────────────
  io.on("connection", (socket: Socket) => {
    const userId = (socket as any).userId as string;
    console.log(`[Socket.io] User connected: ${userId}`);

    // Each user joins their own personal room so they can receive targeted events
    socket.join(`user:${userId}`);

    // Join a booking chat room on demand
    socket.on("join_booking", (bookingId: string) => {
      socket.join(`booking:${bookingId}`);
      console.log(`[Socket.io] ${userId} joined booking:${bookingId}`);
    });

    // Join a service queue room on demand (for real-time queue counter updates)
    socket.on("join_service", (serviceId: string) => {
      socket.join(`service:${serviceId}`);
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
