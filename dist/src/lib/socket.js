import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "./prisma";
let io = null;
/**
 * Initialize Socket.io with the HTTP server.
 * Should be called once in server.ts before app.listen().
 */
export function initSocket(httpServer) {
    io = new SocketIOServer(httpServer, {
        cors: {
            origin: env.FRONTEND_URL,
            credentials: true,
            methods: ["GET", "POST"],
        },
    });
    // ── Auth Middleware ───────────────────────────────────────────────────────
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token ||
                socket.handshake.headers?.authorization?.replace("Bearer ", "");
            if (!token) {
                return next(new Error("Authentication error: no token provided"));
            }
            const payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
            const user = await prisma.user.findUnique({
                where: { id: payload.sub },
                select: { id: true, role: true, isActive: true, emailVerified: true },
            });
            if (!user || !user.isActive || !user.emailVerified) {
                return next(new Error("Authentication error: account unavailable"));
            }
            // Roles and suspension status are read from the database, not from a
            // potentially stale JWT claim.
            socket.userId = user.id;
            socket.role = user.role;
            next();
        }
        catch {
            next(new Error("Authentication error: invalid token"));
        }
    });
    // ── Connection Handler ────────────────────────────────────────────────────
    io.on("connection", (socket) => {
        const userId = socket.userId;
        console.log(`[Socket.io] User connected: ${userId}`);
        // Each user joins their own personal room so they can receive targeted events
        socket.join(`user:${userId}`);
        // Admin users join the global admin room for real-time moderation alerts
        const role = socket.role;
        if (role === "admin") {
            socket.join("admin");
            console.log(`[Socket.io] Admin ${userId} joined room: admin`);
        }
        // Join a booking chat room on demand
        socket.on("join_booking", async (bookingId, acknowledge) => {
            if (typeof bookingId !== "string" || bookingId.length > 64) {
                acknowledge?.({ ok: false, error: "Invalid booking ID" });
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
            }
            catch {
                acknowledge?.({ ok: false, error: "Unable to join booking" });
            }
        });
        // Join a service queue room on demand (for real-time queue counter updates)
        socket.on("join_service", (serviceId) => {
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
export function getIO() {
    if (!io) {
        throw new Error("Socket.io has not been initialized. Call initSocket() first.");
    }
    return io;
}
/**
 * Safely emit to a room — no-ops if socket is not initialized.
 */
export function safeEmit(room, event, data) {
    try {
        getIO().to(room).emit(event, data);
    }
    catch {
        // Socket not initialized (e.g., during testing) — silently skip
    }
}
/**
 * Safely broadcast to all connected clients.
 */
export function safeBroadcast(event, data) {
    try {
        getIO().emit(event, data);
    }
    catch {
        // Socket not initialized — silently skip
    }
}
//# sourceMappingURL=socket.js.map