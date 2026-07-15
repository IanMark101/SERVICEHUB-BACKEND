import { prisma } from "../lib/prisma";
export async function createRequest(seekerId, params) {
    const { categoryId, title, description, budgetMin, budgetMax, urgency } = params;
    // Validate category exists and is active
    const category = await prisma.category.findUnique({
        where: { id: categoryId },
    });
    if (!category || !category.isActive) {
        const err = new Error("Invalid or inactive category");
        err.status = 400;
        throw err;
    }
    return prisma.serviceRequest.create({
        data: {
            seekerId,
            categoryId,
            title,
            description,
            budgetMin,
            budgetMax,
            urgency,
            status: "OPEN",
        },
        include: {
            category: true,
            seeker: {
                select: {
                    id: true,
                    name: true,
                    avatarUrl: true,
                    trustScore: true,
                    verificationStatus: true,
                },
            },
        },
    });
}
export async function listRequests(categoryId) {
    return prisma.serviceRequest.findMany({
        where: {
            status: { in: ["OPEN", "IN_PROGRESS"] },
            ...(categoryId && { categoryId }),
        },
        include: {
            category: true,
            seeker: {
                select: {
                    id: true,
                    name: true,
                    avatarUrl: true,
                    trustScore: true,
                    verificationStatus: true,
                },
            },
        },
        orderBy: { createdAt: "desc" },
    });
}
export async function getMyRequests(seekerId) {
    return prisma.serviceRequest.findMany({
        where: { seekerId },
        include: {
            category: true,
            offers: {
                include: {
                    provider: {
                        select: {
                            id: true,
                            name: true,
                            avatarUrl: true,
                            trustScore: true,
                            verificationStatus: true,
                        },
                    },
                },
            },
        },
        orderBy: { createdAt: "desc" },
    });
}
export async function updateRequest(requestId, seekerId, params) {
    const request = await prisma.serviceRequest.findFirst({
        where: { id: requestId, seekerId },
    });
    if (!request) {
        const err = new Error("Request not found or access denied");
        err.status = 404;
        throw err;
    }
    return prisma.serviceRequest.update({
        where: { id: requestId },
        data: params,
    });
}
export async function cancelRequest(requestId, seekerId) {
    const request = await prisma.serviceRequest.findFirst({
        where: { id: requestId, seekerId },
    });
    if (!request) {
        const err = new Error("Request not found or access denied");
        err.status = 404;
        throw err;
    }
    return prisma.serviceRequest.update({
        where: { id: requestId },
        data: { status: "CANCELED" },
    });
}
//# sourceMappingURL=requests.service.js.map