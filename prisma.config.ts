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
    url: enforceDatabaseTlsVerification(process.env["DATABASE_URL"]),
  },
});
