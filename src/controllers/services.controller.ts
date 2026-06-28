import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { CreateServiceSchema, UpdateServiceSchema } from "../schema/services.schema";
import {
  browseServices,
  getServiceById,
  createService,
  updateService,
  toggleServiceAvailability,
  deleteService,
  getMyServices,
} from "../services/services.service";

// ── GET /services — public browse ─────────────────────────────────────────────

export async function browse(req: Request, res: Response, next: NextFunction) {
  try {
    const { categoryId, search, availableOnly } = req.query;
    const services = await browseServices({
      categoryId: categoryId as string | undefined,
      search: search as string | undefined,
      availableOnly: availableOnly === "true",
    });
    res.json({ success: true, data: services });
  } catch (err) {
    next(err);
  }
}

// ── GET /services/:id ─────────────────────────────────────────────────────────

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const service = await getServiceById(req.params.id as string);
    res.json({ success: true, data: service });
  } catch (err) {
    next(err);
  }
}

// ── GET /services/mine — provider's own listings ──────────────────────────────

export async function getMine(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const services = await getMyServices(user.id);
    res.json({ success: true, data: services });
  } catch (err) {
    next(err);
  }
}

// ── POST /services ─────────────────────────────────────────────────────────────

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const input = CreateServiceSchema.parse(req.body);
    const service = await createService(user.id, input);
    res.status(201).json({
      success: true,
      message: "Service submitted for admin review. You will be notified once approved.",
      data: service,
    });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    next(err);
  }
}

// ── PATCH /services/:id ────────────────────────────────────────────────────────

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const input = UpdateServiceSchema.parse(req.body);
    const service = await updateService(req.params.id as string, user.id, input);
    res.json({ success: true, data: service });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    next(err);
  }
}

// ── PATCH /services/:id/toggle ─────────────────────────────────────────────────

export async function toggle(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const service = await toggleServiceAvailability(req.params.id as string, user.id);
    res.json({ success: true, data: service });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /services/:id ───────────────────────────────────────────────────────

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    await deleteService(req.params.id as string, user.id);
    res.json({ success: true, message: "Service listing removed" });
  } catch (err) {
    next(err);
  }
}
