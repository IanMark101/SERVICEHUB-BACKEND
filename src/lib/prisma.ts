import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";
import { enforceDatabaseTlsVerification } from "../config/database-url";

// Singleton Prisma client — prevents connection pool exhaustion in development
// (hot reload would otherwise create multiple instances)

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let prismaInstance: PrismaClient;

if (globalForPrisma.prisma) {
  prismaInstance = globalForPrisma.prisma;
} else {
  const pool = new Pool({
    connectionString: enforceDatabaseTlsVerification(env.DATABASE_URL),
  });
  const adapter = new PrismaPg(pool);
  
  prismaInstance = new PrismaClient({
    adapter,
    log: env.PRISMA_LOG_QUERIES === "true" ? ["query", "error", "warn"] : ["error", "warn"],
    // Queue lifecycle transactions may legitimately wait on a per-service
    // advisory lock. The five-second Prisma default is too short for a remote
    // database during concurrent payment webhooks.
    transactionOptions: {
      maxWait: 10_000,
      timeout: 30_000,
    },
  });

  if (env.NODE_ENV !== "production") {
    globalForPrisma.prisma = prismaInstance;
  }
}

export const prisma = prismaInstance;
