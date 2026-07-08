import { prisma } from "../src/lib/prisma";
import bcrypt from "bcryptjs";

async function main() {
  console.log("🧹 Wiping all existing database records to clean mock data...");

  // Delete records in reverse dependency order to avoid foreign key violations
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
  await prisma.refreshToken.deleteMany({});
  await prisma.emailVerificationToken.deleteMany({});
  await prisma.passwordResetToken.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.category.deleteMany({});

  console.log("🌱 Seeding production-ready demonstration dataset...");

  const passwordHash = await bcrypt.hash("password1234", 10);

  // 1. Seed Categories
  const plumbing = await prisma.category.create({ data: { name: "Plumbing", isActive: true } });
  const electrical = await prisma.category.create({ data: { name: "Electrical Repair", isActive: true } });
  const cleaning = await prisma.category.create({ data: { name: "Cleaning Services", isActive: true } });

  // 2. Seed Administrator
  const admin = await prisma.user.create({
    data: {
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
  console.log("✅ Seeded Admin: admin@servicehub.com");

  // 3. Seed Verified Seeker (Dual Workspace)
  const dualUser = await prisma.user.create({
    data: {
      id: "udual",
      name: "Juan Seeker",
      email: "test.seeker@servicehub.com",
      passwordHash,
      phone: "+63 917 111 2222",
      location: "San Miguel, Cordova",
      role: "user",
      trustScore: 75,
      verificationStatus: "APPROVED",
      emailVerified: true,
      bio: "Active seeker needing various domestic tasks done and offering minor services."
    }
  });
  console.log("✅ Seeded Dual-Workspace Seeker: test.seeker@servicehub.com");

  // 4. Seed Verified Provider
  const provider = await prisma.user.create({
    data: {
      id: "uprovider",
      name: "Maria Provider",
      email: "test.provider@servicehub.com",
      passwordHash,
      phone: "+63 918 333 4444",
      location: "Bangbang, Cordova",
      role: "user",
      trustScore: 92,
      verificationStatus: "APPROVED",
      emailVerified: true,
      bio: "Professional plumbing technician with 8 years of Cordova community experience."
    }
  });
  console.log("✅ Seeded Verified Provider: test.provider@servicehub.com");

  // 5. Seed Unverified User (Awaiting Verification)
  const unverified = await prisma.user.create({
    data: {
      id: "uunverified",
      name: "Delfin Unverified",
      email: "test.unverified@servicehub.com",
      passwordHash,
      phone: "+63 920 123 7890",
      location: "Poblacion, Cordova",
      role: "user",
      trustScore: 50,
      verificationStatus: "PENDING_REVIEW",
      emailVerified: true
    }
  });
  console.log("✅ Seeded Unverified User: test.unverified@servicehub.com");

  // Seed pending verification submission for the unverified user
  const verification = await prisma.serviceVerification.create({
    data: {
      userId: unverified.id,
      status: "PENDING_REVIEW",
      proofs: {
        create: [
          {
            fileUrl: "https://images.unsplash.com/photo-1554774853-aae0a22c8aa4",
            documentType: "barangay_id"
          },
          {
            fileUrl: "https://images.unsplash.com/photo-1554774853-aae0a22c8aa4",
            documentType: "proof_of_residency"
          }
        ]
      }
    }
  });
  console.log("✅ Seeded Pending Verification Queue for Delfin");

  // 6. Seed Service Listings
  const s1 = await prisma.service.create({
    data: {
      id: "service1",
      providerId: provider.id,
      categoryId: plumbing.id,
      title: "Expert Leak Diagnostics",
      description: "Immediate pipe repair, leak troubleshooting, and bathroom faucet fixes in Cordova.",
      price: 450.00,
      priceType: "FIXED",
      estimatedDurationMins: 45,
      queueLimit: 5,
      paymentMethods: { cash: true, gcash: true, maya: false },
      status: "ACTIVE",
      isAvailable: true
    }
  });

  const s2 = await prisma.service.create({
    data: {
      id: "service2",
      providerId: dualUser.id, // Juan Seeker acting as Provider
      categoryId: plumbing.id,
      title: "Premium Drain Unclogging",
      description: "Quick unclogging of sinks, toilets, and floor drains with specialized equipment.",
      price: 350.00,
      priceType: "FIXED",
      estimatedDurationMins: 30,
      queueLimit: 3,
      paymentMethods: { cash: true, gcash: false, maya: false },
      status: "ACTIVE",
      isAvailable: true
    }
  });
  console.log("✅ Seeded Active Listings for both providers");

  // 7. Seed 5 completed bookings + reviews for Maria Provider to populate AI Summarizer context
  const mockSeekers = [
    { name: "Anna Ramos", email: "anna@gmail.com" },
    { name: "Robert Dy", email: "robert@gmail.com" },
    { name: "Clara Tan", email: "clara@gmail.com" },
    { name: "Vicente Lim", email: "vicente@gmail.com" },
    { name: "Luz Castro", email: "luz@gmail.com" }
  ];

  for (let i = 0; i < mockSeekers.length; i++) {
    const s = mockSeekers[i];
    const sk = await prisma.user.create({
      data: {
        name: s.name,
        email: s.email,
        passwordHash,
        phone: "+63 917 222 " + (3000 + i),
        location: "Poblacion, Cordova",
        role: "user",
        trustScore: 60,
        verificationStatus: "APPROVED",
        emailVerified: true
      }
    });

    const b = await prisma.booking.create({
      data: {
        id: `bk_mock_${i}`,
        seekerId: sk.id,
        providerId: provider.id,
        serviceId: s1.id,
        paymentMethod: "On-site Cash",
        paymentStatus: "RELEASED",
        status: "COMPLETED",
        started: true
      }
    });

    const cs = await prisma.completedService.create({
      data: {
        id: `cs_mock_${i}`,
        bookingId: b.id,
        seekerId: sk.id,
        providerId: provider.id,
        finalPrice: 450.00,
        paymentStatus: "RELEASED"
      }
    });

    await prisma.review.create({
      data: {
        completedServiceId: cs.id,
        authorId: sk.id,
        targetId: provider.id,
        rating: 4 + (i % 2), // ratings between 4 and 5
        text: `Superb plumbing service! Job #${i + 1} was resolved quickly. Maria is very clean, professional, and on time. Highly recommended!`,
        editableUntil: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });

    await prisma.transaction.create({
      data: {
        walletOwnerId: provider.id,
        type: "EARNING",
        amount: 450.00,
        status: "completed",
        relatedBookingId: cs.id,
        description: `Earning from completed service: ${s1.title}`
      }
    });
  }
  console.log("✅ Seeded 5 Completed Booking Reviews for Maria Provider (triggers AI Summary)");

  // 8. Seed 1 Category Suggestion
  await prisma.categorySuggested.create({
    data: {
      submitterId: dualUser.id,
      name: "Carpentry",
      description: "Services related to cabinet fabrication, wood repairs, door hanging, and furniture restoration.",
      status: "PENDING"
    }
  });
  console.log("✅ Seeded Category Suggestion: Carpentry");

  // 9. Seed 1 pending report / dispute
  const disputeBooking = await prisma.booking.create({
    data: {
      id: "dispute_booking",
      seekerId: dualUser.id,
      providerId: provider.id,
      serviceId: s1.id,
      paymentMethod: "GCash",
      paymentStatus: "PAID_HELD",
      status: "DISPUTED",
      started: true
    }
  });

  await prisma.report.create({
    data: {
      id: "dispute_report",
      bookingId: disputeBooking.id,
      reporterId: dualUser.id,
      reportedUserId: provider.id,
      reason: "INCOMPLETE_SERVICE",
      description: "Maria left before completing the pressure test on the kitchen line. The pipeline is still dripping.",
      status: "PENDING"
    }
  });
  console.log("✅ Seeded Dispute / Report for review");

  // 10. Seed 1 escalated cancellation
  const cancelBooking = await prisma.booking.create({
    data: {
      id: "cancel_booking",
      seekerId: dualUser.id,
      providerId: provider.id,
      serviceId: s1.id,
      paymentMethod: "GCash",
      paymentStatus: "PAID_HELD",
      status: "CANCELED",
      started: true
    }
  });

  await prisma.cancellationRequest.create({
    data: {
      bookingId: cancelBooking.id,
      requestedBy: provider.id,
      reason: "Provider emergency car trouble",
      status: "ESCALATED",
      providerNote: "Vehicle broke down near the bridge, unable to make the appointment."
    }
  });
  console.log("✅ Seeded Escalated Cancellation for review");
}

main()
  .then(async () => {
    console.log("🎉 Demonstration dataset initialized successfully!");
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("💥 Seeding failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
