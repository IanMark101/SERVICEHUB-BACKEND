import "./config/load-environment";
import http from "http";
import { env } from "./config/env"; // validates all env vars at startup
import app from "./app";
import { prisma } from "./lib/prisma";
import { initSocket } from "./lib/socket";
import { expireStalePaymentAttempts } from "./services/payment-attempt.service";
import { pruneSecurityHistory } from './services/security-history.service';
import { pruneUnusedListingPhotos } from './services/listing-photos.service';
import { logger } from './utils/logger';

const PORT = parseInt(env.PORT, 10);

function listen(httpServer: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onStartupError = (error: NodeJS.ErrnoException) => reject(error);
    httpServer.once("error", onStartupError);
    httpServer.listen(port, () => {
      httpServer.off("error", onStartupError);
      resolve();
    });
  });
}

async function main() {
  try {
    // Verify database connection
    await prisma.$connect();
    console.log("✅ Database connected");
    await expireStalePaymentAttempts();
    await pruneSecurityHistory();

    // Create HTTP server so Socket.io can share the same port as Express
    const httpServer = http.createServer(app);

    // Attach Socket.io BEFORE listening so it's ready when clients connect
    initSocket(httpServer);

    await listen(httpServer, PORT);
    console.log(`🚀 ServiceHub API running on http://localhost:${PORT}`);
    console.log(`   Environment: ${env.NODE_ENV}`);
    console.log(`   Frontend origin: ${env.FRONTEND_URL}`);

    const paymentExpiryTimer = setInterval(() => {
      expireStalePaymentAttempts().catch((error) => console.error("Payment-attempt expiry job failed", error));
    }, 60_000);
    paymentExpiryTimer.unref();
    const securityHistoryTimer = setInterval(() => {
      pruneSecurityHistory().catch(() => logger.error('security_history_prune_failed'));
    }, 3_600_000);
    securityHistoryTimer.unref();
    let photoPruneRunning = false;
    const listingPhotoTimer = setInterval(() => {
      if (photoPruneRunning) return;
      photoPruneRunning = true;
      pruneUnusedListingPhotos().catch(() => logger.error('listing_photo_prune_failed')).finally(() => { photoPruneRunning = false; });
    }, 3_600_000);
    listingPhotoTimer.unref();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      clearInterval(paymentExpiryTimer);
      clearInterval(securityHistoryTimer);
      clearInterval(listingPhotoTimer);
      console.log(`\n${signal} received — shutting down gracefully...`);
      httpServer.close(async () => {
        await prisma.$disconnect();
        console.log("✅ Database disconnected. Bye!");
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    const startupError = error as NodeJS.ErrnoException;
    if (startupError.code === "EADDRINUSE") {
      console.error(`❌ Port ${PORT} is already in use. Stop the other backend process or set PORT to a free port in .env.`);
    } else {
      console.error("❌ Failed to start server:", error);
    }
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
