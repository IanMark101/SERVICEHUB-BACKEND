import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import {
  createRequest,
  listRequests,
  getMyRequests,
  updateRequest,
  cancelRequest,
} from "../services/requests.service";
import { safeBroadcast } from "../lib/socket";
import { ServiceRequestSchema, ServiceRequestUpdateSchema } from "../schema/marketplace.schema";

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { categoryId, title, description, budgetMin, budgetMax, urgency } = ServiceRequestSchema.parse(req.body);

    const request = await createRequest(user.id, {
      categoryId,
      title,
      description,
      budgetMin,
      budgetMax,
      urgency,
    });

    safeBroadcast("SERVICE_REQUEST_CREATED", request);
    safeBroadcast("SERVICE_REQUESTS_CHANGED", { id: request.id });

    res.status(201).json({ success: true, data: request });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, error: "Validation failed", errors: err.errors });
    }
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { categoryId } = req.query;
    const requests = await listRequests(categoryId as string | undefined);
    res.json({ success: true, data: requests });
  } catch (err) {
    next(err);
  }
}

export async function getMine(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const requests = await getMyRequests(user.id);
    res.json({ success: true, data: requests });
  } catch (err) {
    next(err);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { title, description, budgetMin, budgetMax, status } = ServiceRequestUpdateSchema.parse(req.body);

    const request = await updateRequest(req.params.id as string, user.id, {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(budgetMin !== undefined && { budgetMin }),
      ...(budgetMax !== undefined && { budgetMax }),
      ...(status !== undefined && { status }),
    });

    safeBroadcast("SERVICE_REQUEST_UPDATED", request);
    safeBroadcast("SERVICE_REQUESTS_CHANGED", { id: request.id, status: request.status });

    res.json({ success: true, data: request });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, error: "Validation failed", errors: err.errors });
    }
    next(err);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    await cancelRequest(req.params.id as string, user.id);

    safeBroadcast("SERVICE_REQUEST_DELETED", { id: req.params.id });
    safeBroadcast("SERVICE_REQUESTS_CHANGED", { id: req.params.id });

    res.json({ success: true, message: "Request cancelled" });
  } catch (err) {
    next(err);
  }
}
