// Compatibility facade for existing controllers and tests.
export {
  registerUser,
  loginUser,
  recoverAccessToken,
  refreshAccessToken,
  logoutUser,
  verifyEmail,
  resendVerificationEmail,
  forgotPassword,
  resetPassword,
  googleLoginUser
} from "./auth/authentication.service";
export type { AuthTokens, AuthUser } from "./auth/authentication.service";

export {
  getUserPublicProfile,
  updateUserProfile,
  changeUserPassword
} from "./auth/profile.service";
