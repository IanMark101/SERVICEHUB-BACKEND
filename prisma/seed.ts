import { prisma } from "../src/lib/prisma";
import bcrypt from "bcryptjs";

async function main() {
  console.log("Seeding essential system categories...");

  const categories = [
    "Plumbing",
    "Electrical Repair",
    "House Cleaning",
    "Lawn Care",
    "Tutoring",
    "Aircon Service",
    "Appliance Repair",
    "Carpentry & Woodwork",
  ];

  for (const name of categories) {
    await prisma.category.upsert({
      where: { name },
      update: { isActive: true },
      create: { name, isActive: true },
    });
  }
  console.log("Seeded core system categories.");

  // Administrator bootstrapping is opt-in and requires deployment-provided
  // credentials. Never create a repository-known privileged account.
  const adminEmail = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const adminName = process.env.ADMIN_BOOTSTRAP_NAME?.trim() || "ServiceHub Administrator";

  if (adminEmail || adminPassword) {
    if (!adminEmail || !adminPassword || adminPassword.length < 14) {
      throw new Error(
        "ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD (minimum 14 characters) must both be supplied",
      );
    }

    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await prisma.user.upsert({
      where: { email: adminEmail },
      update: {
        role: "admin",
        verificationStatus: "APPROVED",
        emailVerified: true,
      },
      create: {
        name: adminName,
        email: adminEmail,
        passwordHash,
        phone: process.env.ADMIN_BOOTSTRAP_PHONE?.trim() || "Not provided",
        location: process.env.ADMIN_BOOTSTRAP_LOCATION?.trim() || "Cordova, Cebu",
        role: "admin",
        trustScore: 100,
        verificationStatus: "APPROVED",
        emailVerified: true,
      },
    });
    console.log(`Administrator account ensured for ${adminEmail}. Password was not logged.`);
  } else {
    console.log("Administrator bootstrap skipped; no ADMIN_BOOTSTRAP_* credentials were provided.");
  }
}

main()
  .then(async () => {
    console.log("Seed completed successfully.");
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("Seeding failed:", error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(1);
  });
