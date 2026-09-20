import "dotenv/config";
import { defineConfig } from "prisma/config";
import { enforceDatabaseTlsVerification } from "./src/config/database-url";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed.ts",
  },
  datasource: {
    // Prisma CLI commands should bypass Neon's transaction pooler. Runtime
    // application traffic continues to use the pooled DATABASE_URL in
    // src/lib/prisma.ts. DATABASE_URL remains a compatibility fallback for
    // local PostgreSQL instances where a separate direct URL is unnecessary.
    url: enforceDatabaseTlsVerification(
      process.env["DIRECT_URL"] || process.env["DATABASE_URL"],
    ),
  },
});
