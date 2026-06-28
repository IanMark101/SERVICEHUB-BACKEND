"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const pg_1 = require("pg");
const adapter_pg_1 = require("@prisma/adapter-pg");
const prisma_1 = require("../generated/prisma");
const env_1 = require("../config/env");
// Singleton Prisma client — prevents connection pool exhaustion in development
// (hot reload would otherwise create multiple instances)
const globalForPrisma = globalThis;
let prismaInstance;
if (globalForPrisma.prisma) {
    prismaInstance = globalForPrisma.prisma;
}
else {
    const pool = new pg_1.Pool({ connectionString: env_1.env.DATABASE_URL });
    const adapter = new adapter_pg_1.PrismaPg(pool);
    prismaInstance = new prisma_1.PrismaClient({
        adapter,
        log: env_1.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
    });
    if (env_1.env.NODE_ENV !== "production") {
        globalForPrisma.prisma = prismaInstance;
    }
}
exports.prisma = prismaInstance;
//# sourceMappingURL=prisma.js.map