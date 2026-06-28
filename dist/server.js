"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const env_1 = require("./config/env"); // validates all env vars at startup
const app_1 = __importDefault(require("./app"));
const prisma_1 = require("./lib/prisma");
const PORT = parseInt(env_1.env.PORT, 10);
async function main() {
    try {
        // Verify database connection
        await prisma_1.prisma.$connect();
        console.log("✅ Database connected");
        const server = app_1.default.listen(PORT, () => {
            console.log(`🚀 ServiceHub Cordova API running on http://localhost:${PORT}`);
            console.log(`   Environment: ${env_1.env.NODE_ENV}`);
            console.log(`   Frontend origin: ${env_1.env.FRONTEND_URL}`);
        });
        // Graceful shutdown
        const shutdown = async (signal) => {
            console.log(`\n${signal} received — shutting down gracefully...`);
            server.close(async () => {
                await prisma_1.prisma.$disconnect();
                console.log("✅ Database disconnected. Bye!");
                process.exit(0);
            });
        };
        process.on("SIGTERM", () => shutdown("SIGTERM"));
        process.on("SIGINT", () => shutdown("SIGINT"));
    }
    catch (error) {
        console.error("❌ Failed to start server:", error);
        await prisma_1.prisma.$disconnect();
        process.exit(1);
    }
}
main();
//# sourceMappingURL=server.js.map