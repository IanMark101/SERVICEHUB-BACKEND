import { prisma } from "../src/lib/prisma";
import bcrypt from "bcryptjs";

const CATEGORIES = [
  "Lawn Care",
  "Electrical Repair",
  "Plumbing",
  "Cleaning Services",
  "Appliance Repair",
  "Carpentry",
  "Painting",
  "Tutor / Education",
  "Aircon Service",
  "Laundry Delivery",
  "Computer Repair",
];

async function main() {
  console.log("🌱 Cleaning existing data...");
  await prisma.notification.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.report.deleteMany({});
  await prisma.review.deleteMany({});
  await prisma.transaction.deleteMany({});
  await prisma.completedService.deleteMany({});
  await prisma.queue.deleteMany({});
  await prisma.booking.deleteMany({});
  await prisma.directRequest.deleteMany({});
  await prisma.offer.deleteMany({});
  await prisma.serviceRequest.deleteMany({});
  await prisma.service.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.category.deleteMany({});

  console.log("🌱 Seeding categories...");
  const categoryMap: Record<string, string> = {};
  for (const name of CATEGORIES) {
    const category = await prisma.category.create({
      data: { name, isActive: true },
    });
    categoryMap[name] = category.id;
  }

  console.log("🌱 Seeding users...");
  const passwordHash = await bcrypt.hash("password1234", 10);

  // Seekers
  const alex = await prisma.user.create({
    data: {
      id: "u1",
      name: "Alex Mercer",
      email: "alexmercer@gmail.com",
      passwordHash,
      phone: "+63 917 123 4567",
      location: "Cordova, Cebu",
      bio: "Local homeowner looking for reliable lawn maintenance, plumbing, and general home repairs.",
      role: "user",
      trustScore: 50,
      verificationStatus: "APPROVED",
      emailVerified: true,
    },
  });

  const sarah = await prisma.user.create({
    data: {
      id: "u2",
      name: "Sarah Connor",
      email: "sarah@gmail.com",
      passwordHash,
      phone: "+63 918 888 7777",
      location: "Cordova, Cebu",
      bio: "Property manager in the metro area looking to outsource maintenance tasks quickly.",
      role: "user",
      trustScore: 50,
      verificationStatus: "APPROVED",
      emailVerified: true,
    },
  });

  const maria = await prisma.user.create({
    data: {
      id: "u5",
      name: "Maria Santos",
      email: "maria@gmail.com",
      passwordHash,
      phone: "+63 919 777 6666",
      location: "Cordova, Cebu",
      bio: "Local resident looking for help with household chore scaling, deep cleaning, and appliance fixes.",
      role: "user",
      trustScore: 50,
      verificationStatus: "APPROVED",
      emailVerified: true,
    },
  });

  const delfin = await prisma.user.create({
    data: {
      id: "u6",
      name: "Delfin Labra",
      email: "delfin@gmail.com",
      passwordHash,
      phone: "+63 920 123 7890",
      location: "Cordova, Cebu",
      bio: "Board member at community center, seeking verified technicians for electrical upkeep and minor works.",
      role: "user",
      trustScore: 50,
      verificationStatus: "APPROVED",
      emailVerified: true,
    },
  });

  // Providers
  const john = await prisma.user.create({
    data: {
      id: "u3",
      name: "John Francisco",
      email: "johnfrans@gmail.com",
      passwordHash,
      phone: "+63 917 555 1234",
      location: "Cordova, Cebu",
      bio: "Licensed electrician and professional landscaper with over 6 years of experience.",
      role: "user",
      trustScore: 96,
      verificationStatus: "APPROVED",
      emailVerified: true,
    },
  });

  const jane = await prisma.user.create({
    data: {
      id: "u4",
      name: "Jane Doe",
      email: "janedoe@gmail.com",
      passwordHash,
      phone: "+63 917 999 8888",
      location: "Cordova, Cebu",
      bio: "Professional plumber specializing in pipe fixes, drainage clearing, and sink installations.",
      role: "user",
      trustScore: 92,
      verificationStatus: "APPROVED",
      emailVerified: true,
    },
  });

  const ramon = await prisma.user.create({
    data: {
      id: "u7",
      name: "Ramon Magsaysay",
      email: "ramon@gmail.com",
      passwordHash,
      phone: "+63 918 333 4444",
      location: "Cordova, Cebu",
      bio: "Air conditioner specialist and appliance expert. Experienced with window/split types and refrigerators.",
      role: "user",
      trustScore: 92,
      verificationStatus: "APPROVED",
      emailVerified: true,
    },
  });

  const elena = await prisma.user.create({
    data: {
      id: "u8",
      name: "Elena Del Mar",
      email: "elena@gmail.com",
      passwordHash,
      phone: "+63 915 222 1111",
      location: "Cordova, Cebu",
      bio: "Professional house painter and home cleaning expert. Offers deep washing, exterior styling, and declutter services.",
      role: "user",
      trustScore: 92,
      verificationStatus: "APPROVED",
      emailVerified: true,
    },
  });

  // Admin
  await prisma.user.create({
    data: {
      id: "uadmin",
      name: "Admin Moderator",
      email: "admin@servicehub.com",
      passwordHash,
      phone: "+63 917 000 0000",
      location: "Cordova, Cebu",
      role: "admin",
      trustScore: 100,
      verificationStatus: "APPROVED",
      emailVerified: true,
    },
  });

  console.log("🌱 Seeding services...");
  const s1 = await prisma.service.create({
    data: {
      id: "s1",
      providerId: "u3",
      categoryId: categoryMap["Lawn Care"],
      title: "Expert Backyard Landscaping & Gardening",
      description: "Complete lawn care, weeding, and landscape design to keep your outdoor spaces beautiful.",
      price: 800,
      priceType: "FIXED",
      estimatedDurationMins: 60,
      queueLimit: 5,
      paymentMethods: { cash: true, gcash: true, maya: false },
      status: "ACTIVE",
      isAvailable: true,
    },
  });

  const s2 = await prisma.service.create({
    data: {
      id: "s2",
      providerId: "u3",
      categoryId: categoryMap["Electrical Repair"],
      title: "Emergency Electrical Repair & Wiring",
      description: "Diagnosing power trip issues, fixing short circuits, outlet replacement, and general electrical maintenance for houses.",
      price: 1200,
      priceType: "FIXED",
      estimatedDurationMins: 45,
      queueLimit: 5,
      paymentMethods: { cash: true, gcash: true, maya: false },
      status: "ACTIVE",
      isAvailable: true,
    },
  });

  const s3 = await prisma.service.create({
    data: {
      id: "s3",
      providerId: "u4",
      categoryId: categoryMap["Plumbing"],
      title: "Emergency Plumbing & Pipe Leak Fixes",
      description: "Master plumber with 10 years experience. Immediate response for leaks.",
      price: 1500,
      priceType: "FIXED",
      estimatedDurationMins: 90,
      queueLimit: 3,
      paymentMethods: { cash: true, gcash: true, maya: false },
      status: "ACTIVE",
      isAvailable: true,
    },
  });

  const s4 = await prisma.service.create({
    data: {
      id: "s4",
      providerId: "u8",
      categoryId: categoryMap["Painting"],
      title: "Professional House Painting & Trim Styling",
      description: "Provide uniform wall painting, stain removal, baseboard coatings, and wall repair.",
      price: 2500,
      priceType: "FIXED",
      estimatedDurationMins: 180,
      queueLimit: 3,
      paymentMethods: { cash: true, gcash: true, maya: false },
      status: "ACTIVE",
      isAvailable: true,
    },
  });

  const s5 = await prisma.service.create({
    data: {
      id: "s5",
      providerId: "u7",
      categoryId: categoryMap["Aircon Service"],
      title: "Air Conditioner Deep Cleaning & Freon Refill",
      description: "Full split-type or window-type AC cleaning, coil disinfection, pressure wash, and leak testing.",
      price: 1000,
      priceType: "FIXED",
      estimatedDurationMins: 60,
      queueLimit: 5,
      paymentMethods: { cash: true, gcash: true, maya: false },
      status: "ACTIVE",
      isAvailable: true,
    },
  });

  console.log("🌱 Seeding service requests...");
  await prisma.serviceRequest.create({
    data: {
      id: "jr1",
      seekerId: "u1",
      categoryId: categoryMap["Lawn Care"],
      title: "Garden Hedge Trimming and Cleanup",
      description: "Need a professional to trim tall hedges in the front yard and clean up all cuttings. Hedges are about 7 feet high.",
      budgetMin: 500,
      budgetMax: 900,
      urgency: "medium",
      status: "OPEN",
    },
  });

  await prisma.serviceRequest.create({
    data: {
      id: "jr2",
      seekerId: "u2",
      categoryId: categoryMap["Plumbing"],
      title: "Leaking Pipe Under Bathroom Sink",
      description: "Bathroom sink pipe has a steady drip leak. Need a plumber to replace the joint and seal it properly as soon as possible.",
      budgetMin: 1000,
      budgetMax: 1500,
      urgency: "high",
      status: "OPEN",
    },
  });

  await prisma.serviceRequest.create({
    data: {
      id: "jr3",
      seekerId: "u5",
      categoryId: categoryMap["Plumbing"],
      title: "Washing Machine Drainage Repair",
      description: "Washing machine drainage hose is clogged or broken. Water leaks all over the floor whenever it spins. Need replacement.",
      budgetMin: 500,
      budgetMax: 850,
      urgency: "medium",
      status: "OPEN",
    },
  });

  await prisma.serviceRequest.create({
    data: {
      id: "jr4",
      seekerId: "u6",
      categoryId: categoryMap["Electrical Repair"],
      title: "Fix Tripping Circuit Breaker",
      description: "Our main breaker trips every time we turn on the living room air conditioning unit. Need someone to diagnose overload or short circuits.",
      budgetMin: 800,
      budgetMax: 1200,
      urgency: "high",
      status: "OPEN",
    },
  });

  console.log("🌱 Seeding bids/offers...");
  await prisma.offer.create({
    data: {
      id: "b1",
      requestId: "jr1",
      providerId: "u3",
      offeredPrice: 850,
      estimatedDuration: 60,
      message: "Hello Alex, I can bring my tall ladders and trimmers tomorrow morning. Will clean and take away all cuttings.",
      status: "PENDING",
    },
  });

  await prisma.offer.create({
    data: {
      id: "b2",
      requestId: "jr2",
      providerId: "u4",
      offeredPrice: 1400,
      estimatedDuration: 45,
      message: "I have standard replacement joints in my kit. I can pass by at 10 AM to resolve this for you.",
      status: "PENDING",
    },
  });

  await prisma.offer.create({
    data: {
      id: "b3",
      requestId: "jr3",
      providerId: "u4",
      offeredPrice: 800,
      estimatedDuration: 60,
      message: "Hi Maria, I can replace the hose and clean the internal lint filters to ensure a perfect flow.",
      status: "PENDING",
    },
  });

  await prisma.offer.create({
    data: {
      id: "b4",
      requestId: "jr3",
      providerId: "u8",
      offeredPrice: 850,
      estimatedDuration: 60,
      message: "I specialize in cleaning and draining repairs. Can drop by today if needed.",
      status: "PENDING",
    },
  });

  await prisma.offer.create({
    data: {
      id: "b5",
      requestId: "jr4",
      providerId: "u3",
      offeredPrice: 1100,
      estimatedDuration: 45,
      message: "Hi Delfin, it sounds like an overload or faulty fuse switch. I have full testing meters to diagnose this.",
      status: "PENDING",
    },
  });

  console.log("🌱 Seeding bookings (active engagements)...");

  // Booking 1: Seeker Alex, Provider Jane, service s3, status ONGOING
  const book1 = await prisma.booking.create({
    data: {
      id: "je1",
      seekerId: "u1",
      providerId: "u4",
      serviceId: "s3",
      paymentMethod: "GCash",
      paymentStatus: "PAID_HELD",
      status: "ONGOING",
    },
  });

  // Booking 2: Seeker Sarah, Provider John, service s1, status AWAITING_CONFIRMATION
  const book2 = await prisma.booking.create({
    data: {
      id: "je2",
      seekerId: "u2",
      providerId: "u3",
      serviceId: "s1",
      paymentMethod: "On-site Cash",
      paymentStatus: "UNPAID",
      status: "AWAITING_CONFIRMATION",
    },
  });

  // Booking 3: Seeker Delfin, Provider Ramon, service s5, status WAITING
  const book3 = await prisma.booking.create({
    data: {
      id: "je3",
      seekerId: "u6",
      providerId: "u7",
      serviceId: "s5",
      paymentMethod: "GCash",
      paymentStatus: "PAID_HELD",
      status: "WAITING",
      queuePosition: 2,
    },
  });

  // Seed another booking at position 1 in queue for Ramon to make it busy
  const book3Serve = await prisma.booking.create({
    data: {
      id: "je3_serve",
      seekerId: "u1",
      providerId: "u7",
      serviceId: "s5",
      paymentMethod: "GCash",
      paymentStatus: "PAID_HELD",
      status: "ONGOING",
      queuePosition: 1,
    },
  });

  await prisma.queue.create({
    data: {
      id: "q_je3_serve",
      serviceId: "s5",
      seekerId: "u1",
      paymentId: "pi_ramon_serve",
      paymentStatus: "PAID_HELD",
      position: 1,
      status: "SERVING",
      estimatedWait: 0,
      bookingId: book3Serve.id,
    },
  });

  await prisma.queue.create({
    data: {
      id: "q_je3",
      serviceId: "s5",
      seekerId: "u6",
      paymentId: "pi_ramon_wait",
      paymentStatus: "PAID_HELD",
      position: 2,
      status: "WAITING",
      estimatedWait: 60,
      bookingId: book3.id,
    },
  });

  // Booking 4: Seeker Maria, Provider Elena, service s4, status ACCEPTED
  await prisma.booking.create({
    data: {
      id: "je4",
      seekerId: "u5",
      providerId: "u8",
      serviceId: "s4",
      paymentMethod: "On-site Cash",
      paymentStatus: "UNPAID",
      status: "ACCEPTED",
    },
  });

  // Booking 5 (Disputed): Seeker Sarah, Provider Elena, service s4, status DISPUTED
  const book5 = await prisma.booking.create({
    data: {
      id: "je5",
      seekerId: "u2",
      providerId: "u8",
      serviceId: "s4",
      paymentMethod: "GCash",
      paymentStatus: "FROZEN_HELD",
      status: "DISPUTED",
    },
  });

  await prisma.report.create({
    data: {
      id: "ur2",
      bookingId: book5.id,
      reporterId: "u2",
      reportedUserId: "u8",
      reason: "POOR_SERVICE_QUALITY",
      description: "Paint coat is uneven and contractor used a different color than agreed.",
      status: "PENDING",
    },
  });

  console.log("🌱 Seeding completed services history...");
  const cs1 = await prisma.completedService.create({
    data: {
      id: "past_cs_1",
      seekerId: "u1",
      providerId: "u3",
      finalPrice: 800,
      paymentStatus: "RELEASED",
    },
  });

  const cs2 = await prisma.completedService.create({
    data: {
      id: "past_cs_2",
      seekerId: "u2",
      providerId: "u4",
      finalPrice: 1500,
      paymentStatus: "RELEASED",
    },
  });

  console.log("🌱 Seeding transactions...");
  await prisma.transaction.create({
    data: {
      id: "tx1",
      walletOwnerId: "u3",
      type: "EARNING",
      amount: 800,
      status: "completed",
      relatedBookingId: cs1.id,
      description: "Backyard landscaping payout",
    },
  });

  await prisma.transaction.create({
    data: {
      id: "tx2",
      walletOwnerId: "u4",
      type: "EARNING",
      amount: 1500,
      status: "completed",
      relatedBookingId: cs2.id,
      description: "Kitchen plumbing repair payout",
    },
  });

  console.log("🌱 Seeding messaging history...");
  await prisma.message.create({
    data: {
      bookingId: book1.id,
      senderId: "u1",
      receiverId: "u4",
      content: "Hi Jane, let me know when you can arrive for the pipe leak repair.",
    },
  });

  await prisma.message.create({
    data: {
      bookingId: book1.id,
      senderId: "u4",
      receiverId: "u1",
      content: "Hello Alex, I am getting my tools ready. Will be there in about 20 minutes.",
    },
  });

  console.log("🌱 Seeding waitlist queue notifications...");
  await prisma.queueNotify.create({
    data: {
      serviceId: "s3",
      seekerId: "u5",
    },
  });

  console.log("🌱 Seeding finished successfully!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
