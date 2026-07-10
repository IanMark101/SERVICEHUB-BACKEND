/*
  Warnings:

  - You are about to drop the column `completedServiceId` on the `messages` table. All the data in the column will be lost.
  - You are about to drop the column `completedServiceId` on the `reports` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[bookingId]` on the table `completed_services` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[bookingId]` on the table `queue` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `bookingId` to the `messages` table without a default value. This is not possible if the table is not empty.
  - Added the required column `bookingId` to the `reports` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING_APPROVAL', 'WAITING', 'ONGOING', 'ACCEPTED', 'AWAITING_CONFIRMATION', 'UNDER_REVIEW', 'DISPUTED', 'DECLINED', 'CANCELED', 'REMOVED', 'COMPLETED');

-- DropForeignKey
ALTER TABLE "messages" DROP CONSTRAINT "messages_completedServiceId_fkey";

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_completedServiceId_fkey";

-- AlterTable
ALTER TABLE "completed_services" ADD COLUMN     "bookingId" TEXT;

-- AlterTable
ALTER TABLE "messages" DROP COLUMN "completedServiceId",
ADD COLUMN     "bookingId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "queue" ADD COLUMN     "bookingId" TEXT;

-- AlterTable
ALTER TABLE "reports" DROP COLUMN "completedServiceId",
ADD COLUMN     "bookingId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "seekerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "serviceId" TEXT,
    "offerId" TEXT,
    "directRequestId" TEXT,
    "paymentMethod" TEXT NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PAID_HELD',
    "status" "BookingStatus" NOT NULL DEFAULT 'WAITING',
    "queuePosition" INTEGER,
    "started" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_requests" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL,
    "providerNote" TEXT,
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "cancellation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bookings_offerId_key" ON "bookings"("offerId");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_directRequestId_key" ON "bookings"("directRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "completed_services_bookingId_key" ON "completed_services"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "queue_bookingId_key" ON "queue"("bookingId");

-- AddForeignKey
ALTER TABLE "queue" ADD CONSTRAINT "queue_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_seekerId_fkey" FOREIGN KEY ("seekerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_directRequestId_fkey" FOREIGN KEY ("directRequestId") REFERENCES "direct_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "completed_services" ADD CONSTRAINT "completed_services_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
