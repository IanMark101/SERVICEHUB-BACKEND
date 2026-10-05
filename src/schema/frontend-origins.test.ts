import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import app from "../app";
import { env } from "../config/env";
import { deploymentFrontendOrigins, getAllowedFrontendOrigins } from "../config/frontend-origins";
import { initSocket } from "../lib/socket";

test("configured origins are normalized and unsafe or malformed entries are excluded", t => {
  const savedUrl = env.FRONTEND_URL;
  const savedOrigins = env.FRONTEND_ORIGINS;
  t.after(() => { env.FRONTEND_URL = savedUrl; env.FRONTEND_ORIGINS = savedOrigins; });
  env.FRONTEND_URL = "https://servicehubcordova.tech/";
  env.FRONTEND_ORIGINS = " https://extra.example/ , https://extra.example, *, https://*.example, not-a-url, https://extra.example/path, https://user:pass@extra.example, ftp://extra.example";
  const origins = getAllowedFrontendOrigins();
  assert.deepEqual(origins, [...deploymentFrontendOrigins, "https://extra.example"]);
});

test("HTTP, Socket.IO, and production cookie endpoints trust the three frontend hosts only by exact origin", async t => {
  const savedMode = env.NODE_ENV;
  env.NODE_ENV = "production";
  t.after(() => { env.NODE_ENV = savedMode; });
  const server = http.createServer(app);
  const io = initSocket(server);
  t.after(() => new Promise<void>(resolve => { io.close(() => resolve()); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const origin of deploymentFrontendOrigins) {
    for (const route of ["/api/auth/google-login", "/socket.io/?EIO=4&transport=polling"]) {
      const response = await fetch(`${base}${route}`, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
      });
      assert.equal(response.status, 204, `${origin} ${route}`);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.equal(response.headers.get("access-control-allow-credentials"), "true");
      assert.match(response.headers.get("vary") || "", /Origin/);
    }
    const session = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { Origin: origin } });
    assert.equal(session.status, 200);
    assert.equal((await session.json() as any).data.authenticated, false);
    const refresh = await fetch(`${base}/api/auth/refresh`, { method: "POST", headers: { Origin: origin } });
    assert.equal(refresh.status, 401, "allowed origins reach refresh-token validation");
    const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Origin: origin } });
    assert.equal(logout.status, 200);
  }

  for (const origin of ["https://servicehubcordova.tech.evil.example", "https://evil.servicehubcordova.tech", "http://servicehubcordova.tech", "https://untrusted.example", "null"]) {
    for (const route of ["/api/auth/google-login", "/socket.io/?EIO=4&transport=polling"]) {
      const response = await fetch(`${base}${route}`, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
      });
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    const session = await fetch(`${base}/api/auth/session`, { method: "POST", headers: { Origin: origin } });
    assert.equal(session.status, 403, `reject ${origin}`);
  }
  const missingOrigin = await fetch(`${base}/api/auth/session`, { method: "POST" });
  assert.equal(missingOrigin.status, 403);
});
