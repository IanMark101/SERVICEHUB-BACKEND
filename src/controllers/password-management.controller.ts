import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { SetPasswordSchema, VerifyPasswordGoogleSchema } from "../schema/password.schema";
import { getSecurityMethods, setUserPassword, startPasswordSetup, verifyPasswordSetup } from "../services/auth/password-management.service";
import { disconnectOtherUserSessions } from "../lib/socket";

const identity = (req: Request) => {
  const { user, sessionId } = req as AuthenticatedRequest;
  if (!sessionId) throw Object.assign(new Error("Sign in again."), { status: 401 });
  return { userId: user.id, sessionId };
};
export async function securityMethods(req: Request, res: Response, next: NextFunction) {
  try { res.setHeader("Cache-Control", "no-store"); res.json({ success: true, data: await getSecurityMethods(identity(req).userId) }); } catch (error) { next(error); }
}
export async function passwordSetupChallenge(req: Request, res: Response, next: NextFunction) {
  try { const { userId, sessionId } = identity(req); res.json({ success: true, data: await startPasswordSetup(userId, sessionId) }); } catch (error) { next(error); }
}
export async function passwordSetupVerification(req: Request, res: Response, next: NextFunction) {
  try { const { userId, sessionId } = identity(req); const { credential, challenge } = VerifyPasswordGoogleSchema.parse(req.body); res.json({ success: true, data: await verifyPasswordSetup(userId, sessionId, credential, challenge) }); } catch (error) { next(error); }
}
export async function setPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, sessionId } = identity(req); const { grant, newPassword } = SetPasswordSchema.parse(req.body);
    const methods = await setUserPassword(userId, sessionId, grant, newPassword);
    res.json({ success: true, message: "Password created. You can now sign in with Google or email and password.", data: methods });
    void disconnectOtherUserSessions(userId, sessionId);
  } catch (error) { next(error); }
}
