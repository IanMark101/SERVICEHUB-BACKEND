import "dotenv/config";
import http from "http";
import { env } from "./config/env"; // validates all env vars at startup
import app from "./app";
import { prisma } from "./lib/prisma";
import { initSocket } from "./lib/socket";
const PORT = parseInt(env.PORT, 10);
async function main() {
    try {
        // Verify database connection
        await prisma.$connect();
        console.log("✅ Database connected");
        // Create HTTP server so Socket.io can share the same port as Express
        const httpServer = http.createServer(app);
        // Attach Socket.io BEFORE listening so it's ready when clients connect
        initSocket(httpServer);
        httpServer.listen(PORT, () => {
            console.log(`🚀 ServiceHub Cordova API running on http://localhost:${PORT}`);
            console.log(`   Environment: ${env.NODE_ENV}`);
            console.log(`   Frontend origin: ${env.FRONTEND_URL}`);
        });
        // Graceful shutdown
        const shutdown = async (signal) => {
            console.log(`\n${signal} received — shutting down gracefully...`);
            httpServer.close(async () => {
                await prisma.$disconnect();
                console.log("✅ Database disconnected. Bye!");
                process.exit(0);
            });
        };
        process.on("SIGTERM", () => shutdown("SIGTERM"));
        process.on("SIGINT", () => shutdown("SIGINT"));
    }
    catch (error) {
        console.error("❌ Failed to start server:", error);
        await prisma.$disconnect();
        process.exit(1);
    }
}
main();
//# sourceMappingURL=server.js.map