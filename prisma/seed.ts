import { prisma } from "../src/lib/prisma";
import bcrypt from "bcryptjs";

async function main() {
  console.log("🧹 Cleaning up all mock seeded user accounts and dummy data...");

  // List of mock emails created for testing
  const mockEmails = [
    "test.seeker@servicehub.com",
    "test.provider@servicehub.com",
    "test.unverified@servicehub.com",
    "test.banned@servicehub.com",
    "anna@gmail.com",
    "robert@gmail.com",
    "clara@gmail.com",
    "vicente@gmail.com",
    "luz@gmail.com"
  ];

  // 1. Delete dependent dummy records
  await prisma.review.deleteMany({});
  await prisma.report.deleteMany({});
  await prisma.cancellationRequest.deleteMany({});
  await prisma.transaction.deleteMany({});
  await prisma.completedService.deleteMany({});
  await prisma.queueNotify.deleteMany({});
  await prisma.queue.deleteMany({});
  await prisma.booking.deleteMany({});
  await prisma.directRequest.deleteMany({});
  await prisma.offer.deleteMany({});
  await prisma.serviceRequest.deleteMany({});
  await prisma.service.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.categorySuggested.deleteMany({});
  await prisma.verificationProof.deleteMany({});
  await prisma.serviceVerification.deleteMany({});
  await prisma.aiReviewSummary.deleteMany({});

  // 2. Delete mock users specifically, keeping real user accounts intact
  await prisma.user.deleteMany({
    where: {
      email: { in: mockEmails }
    }
  });

  console.log("🌱 Seeding essential system categories & administrator account...");

  const passwordHash = await bcrypt.hash("password1234", 10);

  // 3. Ensure Core System Categories
  const categories = [
    "Plumbing",
    "Electrical Repair",
    "Cleaning Services",
    "Aircon Repair & Maintenance",
    "Carpentry & Woodwork",
    "Appliance Repair"
  ];

  for (const name of categories) {
    await prisma.category.upsert({
      where: { name },
      update: { isActive: true },
      create: { name, isActive: true }
    });
  }
  console.log("✅ Seeded Core System Categories");

  // 4. Ensure Administrator Account
  await prisma.user.upsert({
    where: { email: "admin@servicehub.com" },
    update: {
      role: "admin",
      verificationStatus: "APPROVED",
      emailVerified: true
    },
    create: {
      id: "uadmin",
      name: "Admin Moderator",
      email: "admin@servicehub.com",
      passwordHash,
      phone: "+63 917 000 0000",
      location: "Poblacion, Cordova",
      role: "admin",
      trustScore: 100,
      verificationStatus: "APPROVED",
      emailVerified: true
    }
  });
  console.log("✅ Seeded Admin: admin@servicehub.com (password: password1234)");
}

main()
  .then(async () => {
    console.log("🎉 Clean production seed completed successfully!");
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("💥 Seeding failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
