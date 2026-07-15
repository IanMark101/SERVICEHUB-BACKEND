import { prisma } from "../src/lib/prisma";
import bcrypt from "bcryptjs";
async function main() {
    console.log("🧹 Wiping all existing database records to eliminate mock data...");
    // Delete records in reverse dependency order to avoid foreign key violations
    await prisma.review.deleteMany({});
    await prisma.report.deleteMany({});
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
    await prisma.user.deleteMany({});
    await prisma.category.deleteMany({});
    console.log("🌱 Seeding dedicated clean test accounts...");
    const passwordHash = await bcrypt.hash("Password123!", 10);
    // 1. Create Seeker
    const seeker = await prisma.user.create({
        data: {
            name: "Juan Seeker",
            email: "test.seeker@servicehub.com",
            passwordHash,
            phone: "+63 917 111 2222",
            location: "Poblacion, Cordova",
            role: "seeker",
            emailVerified: true,
            trustScore: 50,
            verificationStatus: "UNVERIFIED"
        }
    });
    console.log("✅ Created Seeker: test.seeker@servicehub.com");
    // 2. Create Provider
    const provider = await prisma.user.create({
        data: {
            name: "Maria Provider",
            email: "test.provider@servicehub.com",
            passwordHash,
            phone: "+63 918 333 4444",
            location: "San Miguel, Cordova",
            role: "provider",
            emailVerified: true,
            trustScore: 50,
            verificationStatus: "APPROVED"
        }
    });
    console.log("✅ Created Provider: test.provider@servicehub.com");
    // Create Plumbing category
    const plumbingCategory = await prisma.category.create({
        data: { name: "Plumbing", isActive: true }
    });
    // 3. Create Service Listing for Provider
    const service = await prisma.service.create({
        data: {
            providerId: provider.id,
            categoryId: plumbingCategory.id,
            title: "Plumbing & Leak Repair",
            description: "Quick plumbing diagnostics, pipe leak repair, and faucet replacements in Cordova.",
            price: 350.00,
            priceType: "FIXED",
            estimatedDurationMins: 45,
            queueLimit: 5,
            paymentMethods: { cash: true, gcash: true, maya: false },
            status: "ACTIVE",
            isAvailable: true
        }
    });
    console.log(`✅ Created Active Service: "${service.title}" under ${plumbingCategory.name}`);
}
main()
    .then(() => {
    console.log("🎉 Database cleared and clean test accounts seeded successfully!");
    process.exit(0);
})
    .catch((err) => {
    console.error("💥 Seeding failed:", err);
    process.exit(1);
});
//# sourceMappingURL=seed-test-accounts.js.map