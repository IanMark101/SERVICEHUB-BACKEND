import type { Request, Response, NextFunction } from "express";
import {
  RegisterSchema,
  LoginSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
} from "../schema/auth.schema";
import {
  registerUser,
  loginUser,
  refreshAccessToken,
  logoutUser,
  verifyEmail,
  forgotPassword,
  resetPassword,
  googleLoginUser,
  resendVerificationEmail,
} from "../services/auth.service";
import { env } from "../config/env";

// ── Cookie config ─────────────────────────────────────────────────────────────

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict" as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
  path: "/",
};

// ── POST /auth/register ───────────────────────────────────────────────────────

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const result = RegisterSchema.safeParse(req.body);

    if (!result.success) {
        return res.status(400).json({
        errors: result.error.flatten(),
      });
    }
    const { user, tokens } = await registerUser(result.data);

    res.cookie("refreshToken", tokens.refreshToken, REFRESH_COOKIE_OPTIONS);

    res.status(201).json({
      success: true,
      message: "Account created. Please verify your email to unlock full access.",
      data: { user, accessToken: tokens.accessToken },
    });
  } catch (err: any) {
    // Zod validation errors
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    next(err);
  }
}

// ── POST /auth/login ──────────────────────────────────────────────────────────

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const input = LoginSchema.parse(req.body);
    const { user, tokens } = await loginUser(input);

    res.cookie("refreshToken", tokens.refreshToken, REFRESH_COOKIE_OPTIONS);

    res.json({
      success: true,
      data: { user, accessToken: tokens.accessToken },
    });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    next(err);
  }
}

// ── POST /auth/refresh ────────────────────────────────────────────────────────

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const incomingToken = req.cookies?.refreshToken;
    if (!incomingToken) {
      return res.status(401).json({ success: false, error: "No refresh token provided" });
    }

    const tokens = await refreshAccessToken(incomingToken);

    // Rotate the cookie
    res.cookie("refreshToken", tokens.refreshToken, REFRESH_COOKIE_OPTIONS);

    res.json({ success: true, data: { accessToken: tokens.accessToken } });
  } catch (err) {
    next(err);
  }
}

// ── POST /auth/logout ─────────────────────────────────────────────────────────

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.refreshToken;
    if (token) {
      await logoutUser(token);
    }
    res.clearCookie("refreshToken", { path: "/" });
    res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    next(err);
  }
}

// ── GET /auth/verify-email/:token ─────────────────────────────────────────────

export async function verifyEmailHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { token } = req.params as { token: string };

    await verifyEmail(token);

    res.status(200).json({
      success: true,
      message: "Email verified successfully.",
    });
  } catch (err) {
    next(err);
  }
}


export async function resendVerificationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: "Email is required" });
    }
    await resendVerificationEmail(email);
    res.json({ success: true, message: "Verification email sent." });
  } catch (err: any) {
    if (err.status === 429) {
      return res.status(429).json({ success: false, error: err.message });
    }
    next(err);
  }
}

// ── POST /auth/forgot-password ────────────────────────────────────────────────

export async function forgotPasswordHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const input = ForgotPasswordSchema.parse(req.body);
    await forgotPassword(input.email);
    // Always 200 — do not reveal if email exists
    res.json({
      success: true,
      message: "If an account with that email exists, a reset link has been sent.",
    });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    next(err);
  }
}

// ── POST /auth/reset-password ─────────────────────────────────────────────────

export async function resetPasswordHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const input = ResetPasswordSchema.parse(req.body);
    await resetPassword(input.token, input.password);

    // Invalidate session on password reset
    res.clearCookie("refreshToken", { path: "/" });
    res.json({ success: true, message: "Password reset successfully. Please log in again." });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    next(err);
  }
}

// ── GET /auth/me ──────────────────────────────────────────────────────────────
// Returns current user from the JWT (set by requireAuth middleware)

export async function getMe(req: Request, res: Response) {
  res.json({ success: true, data: { user: (req as any).user } });
}

// ── POST /auth/google-login ───────────────────────────────────────────────────

export async function googleLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, error: "Google token is required" });
    }

    const { user, tokens } = await googleLoginUser(token);

    res.cookie("refreshToken", tokens.refreshToken, REFRESH_COOKIE_OPTIONS);
    res.json({
      success: true,
      data: { user, accessToken: tokens.accessToken },
    });
  } catch (err: any) {
    next(err);
  }
}
