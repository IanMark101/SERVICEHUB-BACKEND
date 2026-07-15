import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma";
import { env } from "../config/env";
// Singleton Prisma client — prevents connection pool exhaustion in development
// (hot reload would otherwise create multiple instances)
const globalForPrisma = globalThis;
let prismaInstance;
if (globalForPrisma.prisma) {
    prismaInstance = globalForPrisma.prisma;
}
else {
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    prismaInstance = new PrismaClient({
        adapter,
        log: env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
    });
    if (env.NODE_ENV !== "production") {
        globalForPrisma.prisma = prismaInstance;
    }
}
export const prisma = prismaInstance;
//# sourceMappingURL=prisma.js.map