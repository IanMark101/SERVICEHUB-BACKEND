import { prisma } from "../lib/prisma";
const CORE_CATEGORIES = [
    "Plumbing",
    "Electrical Repair",
    "House Cleaning",
    "Lawn Care",
    "Tutoring",
    "Aircon Service",
    "Appliance Repair",
    "Carpentry & Woodwork"
];
// ── GET /categories ───────────────────────────────────────────────────────────
export async function getCategories(_req, res, next) {
    try {
        let cats = await prisma.category.findMany({
            where: { isActive: true },
            orderBy: { name: "asc" },
        });
        // Auto-seed missing categories if DB is incomplete
        if (cats.length < CORE_CATEGORIES.length) {
            for (const name of CORE_CATEGORIES) {
                await prisma.category.upsert({
                    where: { name },
                    update: { isActive: true },
                    create: { name, isActive: true },
                });
            }
            cats = await prisma.category.findMany({
                where: { isActive: true },
                orderBy: { name: "asc" },
            });
        }
        res.json({ success: true, data: cats });
    }
    catch (err) {
        next(err);
    }
}
// ── POST /categories/suggest ──────────────────────────────────────────────────
export async function suggestCategory(req, res, next) {
    try {
        const { name, description } = req.body;
        if (!name || !description) {
            return res.status(400).json({ success: false, error: "name and description are required" });
        }
        const suggestion = await prisma.categorySuggested.create({
            data: {
                submitterId: req.user.id,
                name,
                description,
                status: "PENDING",
            },
        });
        res.status(201).json({ success: true, data: suggestion });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /categories/suggestions/mine ──────────────────────────────────────────
export async function getMySuggestions(req, res, next) {
    try {
        const suggestions = await prisma.categorySuggested.findMany({
            where: { submitterId: req.user.id },
            orderBy: { submittedAt: "desc" },
        });
        res.json({ success: true, data: suggestions });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=categories.controller.js.map