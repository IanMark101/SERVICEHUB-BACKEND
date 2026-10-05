CREATE TYPE "PasswordState" AS ENUM ('NONE', 'SET', 'LEGACY_UNCONFIRMED');
ALTER TABLE "users"
  ADD COLUMN "passwordState" "PasswordState" NOT NULL DEFAULT 'LEGACY_UNCONFIRMED',
  ADD COLUMN "googleSubject" TEXT,
  ADD COLUMN "googleConnectedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "users_googleSubject_key" ON "users"("googleSubject");

-- Old Google signup stored a random bcrypt hash and recorded no provider identity.
-- Classify only with positive evidence. Never infer a usable password from a hash.
UPDATE "users" u SET "passwordState" = 'SET'
WHERE u.role = 'admin'
   OR EXISTS (SELECT 1 FROM "email_verification_tokens" t WHERE t."userId" = u.id)
   OR EXISTS (SELECT 1 FROM "password_reset_tokens" t WHERE t."userId" = u.id AND t.used = true);
-- Ambiguous legacy passwords remain usable only after a successful password
-- comparison. Google identity is bound to sub at the next verified Google login.
