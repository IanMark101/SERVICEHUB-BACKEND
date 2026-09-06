import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,100}$/;

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const suppliedId = req.header("x-request-id");
  const requestId = suppliedId && REQUEST_ID_PATTERN.test(suppliedId) ? suppliedId : randomUUID();

  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");

  if (env.NODE_ENV === "production" && req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
}
