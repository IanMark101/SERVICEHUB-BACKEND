# Activate Google reCAPTCHA

The implementation uses **reCAPTCHA v2 → “I'm not a robot” Checkbox**. Registration and password reset email requests always require a valid answer when enabled. Password login requires it after three failed sign-ins from the same IP/subnet within 15 minutes. Google OAuth, email verification links, session recovery, and submitting a valid password-reset link keep their existing flows.

## Setup

1. Register a v2 checkbox key at https://www.google.com/recaptcha/admin/create. Use separate production and development keys. For production, register `servicehubcordova.tech` and `www.servicehubcordova.tech`. For development, register `localhost` and open the app using `http://localhost:3000`.
2. Add these settings to the **backend** environment. Keep the secret out of frontend environment variables, Git, logs, and chat:

   ```dotenv
   RECAPTCHA_ENABLED=true
   RECAPTCHA_SITE_KEY=your_public_v2_checkbox_site_key
   RECAPTCHA_SECRET_KEY=your_private_v2_checkbox_secret
   RECAPTCHA_ALLOWED_HOSTNAMES=servicehubcordova.tech,www.servicehubcordova.tech
   ```

   For local keys, use `RECAPTCHA_ALLOWED_HOSTNAMES=localhost` instead. If you use a different development hostname, register it for your Google key and add the exact hostname here. Match the host used in the browser. Schemes, ports, paths, and wildcards are rejected.
3. Restart the backend and deploy/restart the updated frontend. The public site key is fetched from `/api/auth/captcha-config`; a separate frontend reCAPTCHA environment variable or key rebuild is unnecessary.
4. Check registration step 3 and Forgot Password. Try three incorrect password sign-ins; the checkbox should appear before the next attempt. Solve it and verify login. Confirm Google sign-in still works.

The feature defaults to **disabled** to preserve existing login until real keys are configured. Disabled means no CAPTCHA protection. Enabling with missing keys or an invalid allowlist prevents backend startup. Network failure, foreign-host tokens, expired answers, and reused answers block the protected action. Requests time out after five seconds instead of hanging.

## Development tests

Automated tests mock Google's verification endpoint; they never create accounts or send email. Google also provides always-passing v2 test keys in https://developers.google.com/recaptcha/docs/faq. Use them only in isolated development. Google's test responses use `testkey.google.com`, which must be included in the development hostname allowlist if those keys are used. Production configuration rejects the official test keys.

## Deployment notes

- Existing authentication rate limits and email verification still apply.
- Failed-login challenge counters live in the backend process, expire after 15 minutes, and reset on restart. If deployment scales to multiple backend workers/instances, replace this risk counter with shared storage. Keep reverse-proxy trusted-client-IP configuration consistent with the existing rate limiter; do not blindly trust incoming forwarded headers.
- If the host adds CSP, allow Google's documented reCAPTCHA script, frame, and connection URLs (https://developers.google.com/recaptcha/docs/faq).
- Google's iframe supports its own light/dark themes; surrounding ServiceHub UI continues using the shared charcoal theme. The provider-owned iframe cannot inherit ServiceHub's custom colors.
- reCAPTCHA sends verification data to Google. Keep the site's privacy notice accurate for this integration.
