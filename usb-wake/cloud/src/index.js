import { assets } from "./generated-assets.js";
import { ownerAuthorized } from "./auth.js";
import { json } from "./http.js";
export { WakeState } from "./state.js";

const routes = {
  "/api/status": ["GET"],
  "/api/wake": ["POST"],
  "/api/action": ["POST"],
  "/api/schedules": ["POST"],
  "/api/board": ["POST"],
  "/api/login": ["POST"],
  "/api/logout": ["POST"],
  // Management key only: tools/ota.py.
  "/api/firmware": ["PUT", "DELETE"],
  "/device/poll": ["POST"],
  "/device/socket": ["GET"],
  "/device/firmware": ["GET"],
};

const decoded = Object.fromEntries(
  Object.entries(assets).map(([path, asset]) => [
    path,
    {
      type: asset.type,
      body:
        asset.encoding === "base64"
          ? Uint8Array.from(atob(asset.body), (c) => c.charCodeAt(0))
          : asset.body,
    },
  ]),
);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && Object.hasOwn(decoded, path)) {
      const asset = decoded[path];
      return new Response(asset.body, {
        headers: {
          "Content-Type": asset.type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        },
      });
    }
    if (!routes[path]?.includes(request.method))
      return json({ error: "not_found" }, 404);
    if (!env.ADMIN_TOKEN || !env.DEVICE_TOKEN)
      return json({ error: "not_configured" }, 503);
    if (
      path.startsWith("/device/") &&
      !(await ownerAuthorized(request, env.DEVICE_TOKEN))
    )
      return json({ error: "unauthorized" }, 401);
    if (
      path === "/api/firmware" &&
      !(await ownerAuthorized(request, env.ADMIN_TOKEN))
    )
      return json({ error: "unauthorized" }, 401);
    if (request.method === "POST" && path !== "/device/poll") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin)
        return json({ error: "origin_rejected" }, 403);
      if (!request.headers.get("Content-Type")?.startsWith("application/json"))
        return json({ error: "json_required" }, 415);
    }
    try {
      return await env.WAKE_STATE.get(
        env.WAKE_STATE.idFromName("home-pc"),
      ).fetch(request);
    } catch {
      return json({ error: "service_unavailable" }, 503);
    }
  },
};
