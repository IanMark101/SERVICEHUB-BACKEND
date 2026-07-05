"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_1 = require("./lib/prisma");
const bookings_service_1 = require("./services/bookings.service");
const offers_service_1 = require("./services/offers.service");
async function runE2ETests() {
    console.log("🚀 Starting E2E Integration and Spec Compliance Tests...\n");
    let passedCount = 0;
    let failedCount = 0;
    function assert(condition, testName) {
        if (condition) {
            console.log(` ✅ PASS: ${testName}`);
            passedCount++;
        }
        else {
            console.error(` ❌ FAIL: ${testName}`);
            failedCount++;
        }
    }
    try {
        // ── Cleanup Existing Test Records ──────────────────────────────────────────
        console.log("🧹 Cleaning up old test data...");
        await prisma_1.prisma.transaction.deleteMany({ where: { description: { contains: "cancelled" } } });
        await prisma_1.prisma.transaction.deleteMany({ where: { description: { contains: "confirmed" } } });
        await prisma_1.prisma.review.deleteMany({ where: { text: { contains: "E2E" } } });
        await prisma_1.prisma.report.deleteMany({ where: { description: { contains: "Dispute" } } });
        await prisma_1.prisma.cancellationRequest.deleteMany({ where: { reason: { contains: "E2E" } } });
        await prisma_1.prisma.queue.deleteMany({ where: { seeker: { email: { startsWith: "e2e-test-" } } } });
        await prisma_1.prisma.booking.deleteMany({ where: { seeker: { email: { startsWith: "e2e-test-" } } } });
        await prisma_1.prisma.offer.deleteMany({ where: { provider: { email: { startsWith: "e2e-test-" } } } });
        await prisma_1.prisma.serviceRequest.deleteMany({ where: { seeker: { email: { startsWith: "e2e-test-" } } } });
        await prisma_1.prisma.service.deleteMany({ where: { provider: { email: { startsWith: "e2e-test-" } } } });
        await prisma_1.prisma.user.deleteMany({ where: { email: { startsWith: "e2e-test-" } } });
        await prisma_1.prisma.category.deleteMany({ where: { name: "E2E Test Category" } });
        // ── Setup Users and Seed Category ─────────────────────────────────────────
        console.log("🌱 Seeding test users and category...");
        const category = await prisma_1.prisma.category.create({
            data: { name: "E2E Test Category", isActive: true }
        });
        const seeker = await prisma_1.prisma.user.create({
            data: {
                name: "E2E Seeker",
                email: "e2e-test-seeker@example.com",
                passwordHash: "dummyhash",
                phone: "09123456789",
                location: "Cordova",
                emailVerified: true,
                trustScore: 50
            }
        });
        const provider = await prisma_1.prisma.user.create({
            data: {
                name: "E2E Provider",
                email: "e2e-test-provider@example.com",
                passwordHash: "dummyhash",
                phone: "09123456780",
                location: "Cordova",
                emailVerified: true,
                verificationStatus: "APPROVED",
                trustScore: 50
            }
        });
        // Create a service listing owned by provider
        const service = await prisma_1.prisma.service.create({
            data: {
                providerId: provider.id,
                categoryId: category.id,
                title: "E2E Service Listing",
                description: "Specialized testing services in Cordova",
                price: 150.00,
                priceType: "FIXED",
                estimatedDurationMins: 30,
                queueLimit: 3,
                paymentMethods: { cash: true, gcash: true, maya: false },
                status: "ACTIVE",
                isAvailable: true
            }
        });
        // ──────────────────────────────────────────────────────────────────────────
        // FIX 1: Self-Transaction Prohibition (Critical)
        // ──────────────────────────────────────────────────────────────────────────
        console.log("\n🧪 Testing Self-Transaction Prohibition (Fix 1)...");
        // Seeker trying to book direct request with themselves (should fail)
        try {
            await (0, bookings_service_1.createDirectRequest)({
                seekerId: provider.id,
                providerId: provider.id,
                serviceId: service.id,
                agreedPrice: 150.00
            });
            assert(false, "Should have blocked provider from booking their own service directly");
        }
        catch (err) {
            assert(err.code === "SELF_TRANSACTION_NOT_ALLOWED", "Direct request self-transaction check blocked");
        }
        // Seeker trying to book online queue entry with themselves (should fail)
        try {
            await (0, bookings_service_1.addToQueue)({
                serviceId: service.id,
                seekerId: provider.id,
                paymentId: "pay_intent_dummy_self"
            });
            assert(false, "Should have blocked provider from joining their own online service queue");
        }
        catch (err) {
            assert(err.code === "SELF_TRANSACTION_NOT_ALLOWED", "Online queue self-transaction check blocked");
        }
        // Provider trying to submit offer on their own request (should fail)
        const request = await prisma_1.prisma.serviceRequest.create({
            data: {
                seekerId: seeker.id,
                categoryId: category.id,
                title: "E2E Seeker Request",
                description: "Need help with integration tests",
                budgetMin: 100,
                budgetMax: 200,
                urgency: "high"
            }
        });
        // Try to offer on their own request (acting as seeker)
        const requestSelf = await prisma_1.prisma.serviceRequest.create({
            data: {
                seekerId: provider.id,
                categoryId: category.id,
                title: "E2E Provider Request",
                description: "Own request test",
                budgetMin: 100,
                budgetMax: 200,
                urgency: "high"
            }
        });
        try {
            await (0, offers_service_1.submitOffer)(provider.id, {
                requestId: requestSelf.id,
                offeredPrice: 120,
                estimatedDuration: 45
            });
            assert(false, "Should have blocked provider from submitting offer to their own request");
        }
        catch (err) {
            assert(err.code === "SELF_TRANSACTION_NOT_ALLOWED", "Submit offer self-transaction check blocked");
        }
        // ──────────────────────────────────────────────────────────────────────────
        // Flow A: Seeker books directly, Cash path
        // ──────────────────────────────────────────────────────────────────────────
        console.log("\n🧪 Testing Cash Direct Request (Flow A & Part 3)...");
        const directReq = await (0, bookings_service_1.createDirectRequest)({
            seekerId: seeker.id,
            providerId: provider.id,
            serviceId: service.id,
            agreedPrice: 150.00,
            message: "Direct cash test"
        });
        assert(directReq.status === "PENDING_APPROVAL", "Direct request starts with PENDING_APPROVAL status");
        const acceptedBooking = await (0, bookings_service_1.respondToDirectBookingService)(directReq.id, provider.id, true);
        assert(acceptedBooking.status === "ACCEPTED" && acceptedBooking.paymentMethod === "On-site Cash", "Cash direct request accepted -> status ACCEPTED, paymentMethod On-site Cash");
        // ──────────────────────────────────────────────────────────────────────────
        // Flow B: Offer-based matching and sibling auto-rejections
        // ──────────────────────────────────────────────────────────────────────────
        console.log("\n🧪 Testing Offer-Based Matching (Flow B & Part 1)...");
        // Create another offer from provider
        const offer1 = await (0, offers_service_1.submitOffer)(provider.id, {
            requestId: request.id,
            offeredPrice: 130.00,
            estimatedDuration: 30
        });
        assert(offer1.status === "PENDING", "Offer created successfully in PENDING status");
        // Accept this offer
        await (0, offers_service_1.acceptOffer)(offer1.id, seeker.id);
        // Verify request status and offer status updates
        const requestUpdated = await prisma_1.prisma.serviceRequest.findUnique({ where: { id: request.id } });
        const offer1Updated = await prisma_1.prisma.offer.findUnique({ where: { id: offer1.id } });
        assert(requestUpdated?.status === "IN_PROGRESS", "Request status transitions to IN_PROGRESS on offer accept");
        assert(offer1Updated?.status === "ACCEPTED", "Accepted offer status changes to ACCEPTED");
        // ──────────────────────────────────────────────────────────────────────────
        // FIX 2: Cancellation Refund Status and Immediate Refund transaction
        // ──────────────────────────────────────────────────────────────────────────
        console.log("\n🧪 Testing Cancellation Refund & Transactions (Fix 2 & Part 5)...");
        // Register another seeker for queue
        const seeker2 = await prisma_1.prisma.user.create({
            data: {
                name: "E2E Seeker 2",
                email: "e2e-test-seeker2@example.com",
                passwordHash: "dummyhash",
                phone: "09123456781",
                location: "Cordova",
                emailVerified: true
            }
        });
        // Seeker 2 creates online queue booking (position 1)
        const queueRes1 = await (0, bookings_service_1.addToQueue)({
            serviceId: service.id,
            seekerId: seeker2.id,
            paymentId: "pay_intent_test_refund"
        });
        // Seeker 2 cancels before provider started
        const cancelRes = await (0, bookings_service_1.cancelQueueEntry)(queueRes1.queueEntry.id, seeker2.id);
        assert(cancelRes.cancelled === true, "cancelQueueEntry completes successfully");
        // Verify refund statuses
        const cancelledBooking = await prisma_1.prisma.booking.findFirst({
            where: { seekerId: seeker2.id, status: "CANCELED" }
        });
        assert(cancelledBooking?.paymentStatus === "REFUNDED", "Pre-started cancellation sets paymentStatus to REFUNDED");
        const refundTx = await prisma_1.prisma.transaction.findFirst({
            where: { walletOwnerId: seeker2.id, type: "REFUND" }
        });
        assert(refundTx !== null && Number(refundTx.amount) === 150.00, "REFUND Transaction logged in wallet ledger with correct amount");
        // ──────────────────────────────────────────────────────────────────────────
        // FIX 3: Immediate start flag
        // ──────────────────────────────────────────────────────────────────────────
        console.log("\n🧪 Testing Immediate Booking started flag (Fix 3 & Part 3)...");
        const queueRes2 = await (0, bookings_service_1.addToQueue)({
            serviceId: service.id,
            seekerId: seeker.id,
            paymentId: "pay_intent_immediate"
        });
        const immediateBooking = await prisma_1.prisma.booking.findUnique({
            where: { id: queueRes2.queueEntry.bookingId }
        });
        assert(immediateBooking?.started === true && immediateBooking?.status === "ONGOING", "Queue position 1 booking automatically sets started=true and status=ONGOING");
        // ──────────────────────────────────────────────────────────────────────────
        // FIX 4: Queue Position Sync
        // ──────────────────────────────────────────────────────────────────────────
        console.log("\n🧪 Testing Queue Recalculation Sync (Fix 4 & Part 4)...");
        // Create seeker 3 and 4 to join queue (will be position 2 and 3)
        const seeker3 = await prisma_1.prisma.user.create({
            data: { name: "Seeker 3", email: "e2e-test-seeker3@example.com", passwordHash: "h", phone: "0", location: "C" }
        });
        const seeker4 = await prisma_1.prisma.user.create({
            data: { name: "Seeker 4", email: "e2e-test-seeker4@example.com", passwordHash: "h", phone: "0", location: "C" }
        });
        const q3 = await (0, bookings_service_1.addToQueue)({ serviceId: service.id, seekerId: seeker3.id, paymentId: "p3" });
        const q4 = await (0, bookings_service_1.addToQueue)({ serviceId: service.id, seekerId: seeker4.id, paymentId: "p4" });
        // Cancel seeker 3 (position 2)
        await (0, bookings_service_1.cancelQueueEntry)(q3.queueEntry.id, seeker3.id);
        // Verify seeker 4 (position 3) drops to position 2 in both Queue and Booking tables
        const q4Updated = await prisma_1.prisma.queue.findUnique({ where: { id: q4.queueEntry.id } });
        const b4Updated = await prisma_1.prisma.booking.findUnique({ where: { id: q4.queueEntry.bookingId } });
        assert(q4Updated?.position === 2, "recalculateQueue renumbers queue position sequentially (position 3 -> 2)");
        assert(b4Updated?.queuePosition === 2, "Booking.queuePosition successfully synchronized with Queue.position");
        // ──────────────────────────────────────────────────────────────────────────
        // FIX 5: Trust score seeker bonus
        // ──────────────────────────────────────────────────────────────────────────
        console.log("\n🧪 Testing Seeker Completion Trust Score Bonus (Fix 5 & Part 10)...");
        // Complete booking for seeker (which is ongoing)
        await (0, bookings_service_1.confirmCompletionService)(immediateBooking.id, seeker.id);
        const providerTrustUpdated = await prisma_1.prisma.user.findUnique({ where: { id: provider.id }, select: { trustScore: true } });
        const seekerTrustUpdated = await prisma_1.prisma.user.findUnique({ where: { id: seeker.id }, select: { trustScore: true } });
        assert(providerTrustUpdated?.trustScore === 52, "Provider receives +2 completion trust score bonus (50 -> 52)");
        assert(seekerTrustUpdated?.trustScore === 51, "Seeker receives +1 completion trust score bonus (50 -> 51)");
        console.log(`\n🎉 E2E TESTING COMPLETE!`);
        console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);
        if (failedCount > 0) {
            process.exit(1);
        }
        else {
            process.exit(0);
        }
    }
    catch (err) {
        console.error("💥 E2E Test execution failed with error: ", err);
        process.exit(1);
    }
}
runE2ETests();
//# sourceMappingURL=test-e2e.js.map