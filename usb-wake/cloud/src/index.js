import { assets } from "./generated-assets.js";
import { ownerAuthorized } from "./auth.js";
import { json } from "./http.js";
export { WakeState } from "./state.js";

const routes = new Map([
  ["/api/status", "GET"],
  ["/api/wake", "POST"],
  ["/api/login", "POST"],
  ["/api/logout", "POST"],
  ["/api/settings", "POST"],
  ["/device/poll", "POST"],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && assets[path]) {
      const asset = assets[path];
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
    if (routes.get(path) !== request.method)
      return json({ error: "not_found" }, 404);
    if (!env.ADMIN_TOKEN || !env.DEVICE_TOKEN)
      return json({ error: "not_configured" }, 503);
    if (
      path === "/device/poll" &&
      !(await ownerAuthorized(request, env.DEVICE_TOKEN))
    )
      return json({ error: "unauthorized" }, 401);
    if (
      path === "/api/settings" &&
      !(await ownerAuthorized(request, env.ADMIN_TOKEN))
    )
      return json({ error: "invalid_management_key" }, 401);
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
