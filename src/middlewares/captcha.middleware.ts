import { env } from "../config/env";
import { createCaptchaProtection } from "../lib/captcha";

export const { publicConfig: captchaConfig, requireCaptcha, passwordLoginCaptcha } = createCaptchaProtection({
  enabled: env.RECAPTCHA_ENABLED === "true",
  siteKey: env.RECAPTCHA_SITE_KEY || "",
  secretKey: env.RECAPTCHA_SECRET_KEY || "",
  allowedHostnames: env.RECAPTCHA_ALLOWED_HOSTNAMES.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
});
