import { publicLocation } from '../lib/proximity';
import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import {
  createRequest,
  listRequests,
  getMyRequests,
  updateRequest,
  cancelRequest,
  archiveCompletedRequest,
  getRequestRepostTemplate,
} from "../services/requests.service";
import { safeBroadcast } from "../lib/socket";
import { ServiceRequestSchema, ServiceRequestUpdateSchema } from "../schema/marketplace.schema";

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { categoryId, title, description, budgetMin, budgetMax, urgency, paymentMethods, jobLocation, transportationFee } = ServiceRequestSchema.parse(req.body);

    const request = await createRequest(user.id, {
      categoryId,
      title,
      description,
      budgetMin,
      budgetMax,
      urgency,
      paymentMethods, jobLocation, transportationFee,
    });

    safeBroadcast("SERVICE_REQUEST_CREATED", publicLocation(request));
    safeBroadcast("SERVICE_REQUESTS_CHANGED", { id: request.id });

    res.status(201).json({ success: true, data: request });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, error: "Validation failed", errors: err.issues });
    }
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { categoryId } = req.query;
    const requests = await listRequests(categoryId as string | undefined, (req as AuthenticatedRequest).user.id);
    res.json({ success: true, data: requests.map(publicLocation) });
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
    const { title, description, budgetMin, budgetMax, status, paymentMethods, urgency, jobLocation, transportationFee } = ServiceRequestUpdateSchema.parse(req.body);

    const request = await updateRequest(req.params.id as string, user.id, {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(budgetMin !== undefined && { budgetMin }),
      ...(budgetMax !== undefined && { budgetMax }),
      ...(status !== undefined && { status }),
      ...(paymentMethods !== undefined && { paymentMethods }),
      ...(urgency !== undefined && { urgency }),
      ...(jobLocation !== undefined && { jobLocation }),
      ...(transportationFee !== undefined && { transportationFee }),
    });

    safeBroadcast("SERVICE_REQUEST_UPDATED", publicLocation(request));
    safeBroadcast("SERVICE_REQUESTS_CHANGED", { id: request.id, status: request.status });

    res.json({ success: true, data: request });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, error: err.issues[0]?.message || "Validation failed", errors: err.issues });
    }
    next(err);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const request = await cancelRequest(req.params.id as string, user.id);

    safeBroadcast("SERVICE_REQUEST_DELETED", { id: req.params.id });
    safeBroadcast("SERVICE_REQUESTS_CHANGED", { id: req.params.id });

    res.json({ success: true, message: "Request cancelled" });
  } catch (err) {
    next(err);
  }
}

export async function archive(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    await archiveCompletedRequest(req.params.id as string, user.id);
    safeBroadcast('SERVICE_REQUESTS_CHANGED', { id: req.params.id });
    res.json({ success: true, message: 'Request archived. Booking history is unchanged.' });
  } catch (error) { next(error); }
}

export async function repostTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const data = await getRequestRepostTemplate(req.params.id as string, user.id);
    res.json({ success: true, data });
  } catch (error) { next(error); }
}
