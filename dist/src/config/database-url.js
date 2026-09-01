const LEGACY_SSL_MODES = new Set(["prefer", "require", "verify-ca"]);
/**
 * Keep certificate and hostname validation explicit for hosted PostgreSQL.
 * pg-connection-string is changing the meaning of several legacy sslmode
 * values, so normalising them here prevents a future silent TLS downgrade.
 */
export function enforceDatabaseTlsVerification(connectionString) {
    if (!connectionString)
        return connectionString;
    try {
        const url = new URL(connectionString);
        const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
        if (sslMode && LEGACY_SSL_MODES.has(sslMode)) {
            url.searchParams.set("sslmode", "verify-full");
        }
        return url.toString();
    }
    catch {
        // Environment validation and the database client provide the final error.
        return connectionString;
    }
}
//# sourceMappingURL=database-url.js.map