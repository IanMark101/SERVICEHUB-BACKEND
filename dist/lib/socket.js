"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSocket = initSocket;
exports.getIO = getIO;
exports.safeEmit = safeEmit;
const socket_io_1 = require("socket.io");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
let io = null;
/**
 * Initialize Socket.io with the HTTP server.
 * Should be called once in server.ts before app.listen().
 */
function initSocket(httpServer) {
    io = new socket_io_1.Server(httpServer, {
        cors: {
            origin: env_1.env.FRONTEND_URL,
            credentials: true,
            methods: ["GET", "POST"],
        },
    });
    // ── Auth Middleware ───────────────────────────────────────────────────────
    io.use((socket, next) => {
        try {
            const token = socket.handshake.auth?.token ||
                socket.handshake.headers?.authorization?.replace("Bearer ", "");
            if (!token) {
                return next(new Error("Authentication error: no token provided"));
            }
            const payload = jsonwebtoken_1.default.verify(token, env_1.env.JWT_ACCESS_SECRET);
            socket.userId = payload.userId;
            socket.role = payload.role;
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
        // Join a booking chat room on demand
        socket.on("join_booking", (bookingId) => {
            socket.join(`booking:${bookingId}`);
            console.log(`[Socket.io] ${userId} joined booking:${bookingId}`);
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
function getIO() {
    if (!io) {
        throw new Error("Socket.io has not been initialized. Call initSocket() first.");
    }
    return io;
}
/**
 * Safely emit to a room — no-ops if socket is not initialized.
 */
function safeEmit(room, event, data) {
    try {
        getIO().to(room).emit(event, data);
    }
    catch {
        // Socket not initialized (e.g., during testing) — silently skip
    }
}
//# sourceMappingURL=socket.js.map