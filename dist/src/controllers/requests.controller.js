import { createRequest, listRequests, getMyRequests, updateRequest, cancelRequest, } from "../services/requests.service";
export async function create(req, res, next) {
    try {
        const user = req.user;
        const { categoryId, title, description, budgetMin, budgetMax, urgency } = req.body;
        if (!categoryId || !title || !description || !budgetMin || !budgetMax) {
            return res.status(400).json({ success: false, error: "Missing required fields" });
        }
        const request = await createRequest(user.id, {
            categoryId,
            title,
            description,
            budgetMin: parseFloat(budgetMin),
            budgetMax: parseFloat(budgetMax),
            urgency: urgency || "medium",
        });
        res.status(201).json({ success: true, data: request });
    }
    catch (err) {
        next(err);
    }
}
export async function list(req, res, next) {
    try {
        const { categoryId } = req.query;
        const requests = await listRequests(categoryId);
        res.json({ success: true, data: requests });
    }
    catch (err) {
        next(err);
    }
}
export async function getMine(req, res, next) {
    try {
        const user = req.user;
        const requests = await getMyRequests(user.id);
        res.json({ success: true, data: requests });
    }
    catch (err) {
        next(err);
    }
}
export async function update(req, res, next) {
    try {
        const user = req.user;
        const { title, description, budgetMin, budgetMax, status } = req.body;
        const request = await updateRequest(req.params.id, user.id, {
            ...(title && { title }),
            ...(description && { description }),
            ...(budgetMin && { budgetMin: parseFloat(budgetMin) }),
            ...(budgetMax && { budgetMax: parseFloat(budgetMax) }),
            ...(status && { status }),
        });
        res.json({ success: true, data: request });
    }
    catch (err) {
        next(err);
    }
}
export async function remove(req, res, next) {
    try {
        const user = req.user;
        await cancelRequest(req.params.id, user.id);
        res.json({ success: true, message: "Request cancelled" });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=requests.controller.js.map