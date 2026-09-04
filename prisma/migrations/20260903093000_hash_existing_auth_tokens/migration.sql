-- Hash bearer-capability tokens already stored by older application versions.
-- The browser/email continues to hold the original value; the server hashes it
-- before lookup. No user, booking, or financial history is changed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE "refresh_tokens"
SET "token" = encode(digest("token", 'sha256'), 'hex');

UPDATE "email_verification_tokens"
SET "token" = encode(digest("token", 'sha256'), 'hex');

UPDATE "password_reset_tokens"
SET "token" = encode(digest("token", 'sha256'), 'hex');
