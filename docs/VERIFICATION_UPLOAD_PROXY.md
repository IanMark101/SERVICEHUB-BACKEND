# Verification upload proxy repair

Current behavior and release boundary: see CURRENT_SYSTEM.md. Dated implementation checks below retain their original scope. Generated review captures and logs removed during cleanup remain recoverable from the recorded pre-cleanup Git revisions.
Observed October 15, 2026 (Asia/Taipei), against the deployed API.

The phone screenshot's connection message is not enough to identify the friend's exact failed request. Live checks nevertheless reproduced a real upload contract failure:

- API health returned 200.
- Upload preflight returned 204 for both `https://servicehub.bond` and `https://www.servicehub.bond`, with the correct allowed origin and credential support.
- An unauthenticated two-byte upload request returned the expected 401 JSON with CORS and request-ID headers.
- An unauthenticated synthetic request representing an allowed 5 MiB photo produced a 6,990,543-byte JSON body. It returned an Nginx 413 HTML page, with no CORS or application request-ID headers. The API upload handler did not receive that request. No document was stored or verification created by these checks.

VerificationUpload reads each photo as base64 and posts it individually to `/api/upload/verification`. Base64 adds roughly one third to the body size. The browser can expose the proxy rejection as a network error because the Nginx error response lacks the frontend's allowed-origin header. Correcting the frontend origin allowlist alone does not correct an upload body limit.

## Apply on the backend VPS

The application accepts verification photos up to 5 MiB and Express accepts JSON bodies up to 10 MiB. Configure the existing API proxy location with `client_max_body_size 10m;`. Do not set an unlimited body size or replace the application's authentication, file validation or private storage behavior. Do not add duplicate CORS headers at Nginx; successful requests retain the existing Express origin checks.

Copy `scripts/fix-nginx-uploads.py` to the VPS, then run:

```sh
sudo python3 /root/fix-nginx-uploads.py /etc/nginx/sites-enabled/api.servicehubcordova.tech --check
sudo python3 /root/fix-nginx-uploads.py /etc/nginx/sites-enabled/api.servicehubcordova.tech
```

The script scopes its change to the existing API HTTPS vhost and its matching upload proxy, preserves TLS/forwarding headers, backs up the original outside `sites-enabled`, validates Nginx before and after the edit, and reloads only after validation. Failed validation/reload restores the file. Unexpected/ambiguous configurations stop without modification. Use the actual API vhost path if it differs. The snippet in `docker/nginx-upload-limit.conf` documents the same setting for future setup.

For a manual edit, add that directive to the existing API proxy location, then run `sudo nginx -t && sudo systemctl reload nginx`. The `nginx.config` in the repository is a static frontend configuration and is not the deployed API HTTPS proxy; editing that file would not resolve this VPS issue.

## Verify after applying

Repeat the maximum-photo unauthenticated check: it should reach the application's 401 JSON response with its exact allowed-origin header instead of Nginx 413. Then sign in with an authorized test account, select a clear supported document photo, acknowledge the current notice and submit. Confirm `/api/upload/verification` returns 201 and `/api/verifications/submit` succeeds, with the account showing Pending Review. Do not expose real identity documents or tokens in logs/screenshots.

The backend's shared image validator also counted base64 padding as image bytes. A valid photo at exactly 5 MiB could be rejected as one byte over the limit. `upload-image.schema.ts` now counts decoded bytes correctly and rejects malformed base64. Verification and safety evidence retain the 5 MiB limit; other image routes retain their existing 10 MiB validator limit. The Express JSON-body limit is still 10 MiB, so this change does not promise that a raw 10 MiB general image can pass that separate request-body limit.

No database migration, domain change or frontend release is required for the proxy correction. The exact-size backend validation correction requires releasing the updated backend code through the existing deployment workflow. Local script/schema tests do not confirm deployment or authenticated storage success. The live proxy repair and the friend's retry remain pending until applied on the VPS.

Reference: [Nginx client_max_body_size](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size).

## Local verification results

- Seven Python configuration tests passed: API-vhost scoping, retained TLS/auth/WebSocket headers, specific upload locations, existing limit replacement, repeat-run safety, and rejection of unexpected/ambiguous configurations.
- Three backend schema tests passed: exact decoded 5 MiB and 10 MiB boundaries, supported MIME types, and malformed/empty base64 rejection.
- Backend TypeScript check (`tsc --noEmit`) passed.
- Git whitespace check passed for the changed tracked code. The pre-existing master-prompt edits were preserved.

These tests did not run an authenticated production document upload or apply changes to the VPS.
