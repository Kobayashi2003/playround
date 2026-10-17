import {
  controlAuthorized,
  createAccess,
  makeSession,
  passwordMatches,
} from "./auth.js";
import { json, readBody } from "./http.js";

const ONLINE_MS = 20000;
const COMMAND_MS = 30000;

export class WakeState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.lastSeen = 0;
    this.lastPersisted = 0;
    this.attempts = new Map();
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const now = Date.now();
    const access = (await this.ctx.storage.get("access")) ?? {
      enabled: false,
      version: "open",
    };
    if (path === "/api/logout")
      return json({ ok: true }, 200, {
        "Set-Cookie":
          "wake_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure",
      });
    if (path === "/device/poll") return this.poll(request, now);
    if (path === "/api/login") {
      if (!access.enabled) return json({ ok: true });
      const address = request.headers.get("CF-Connecting-IP") ?? "local";
      const attempt = this.attempts.get(address) ?? { at: now, count: 0 };
      if (now - attempt.at >= 60000) {
        attempt.at = now;
        attempt.count = 0;
      }
      if (++attempt.count > 8)
        return json({ error: "too_many_attempts" }, 429, {
          "Retry-After": "60",
        });
      if (this.attempts.size > 256) this.attempts.clear();
      this.attempts.set(address, attempt);
      let body;
      try {
        body = await readBody(request);
      } catch {
        return json({ error: "invalid_request" }, 400);
      }
      if (!(await passwordMatches(body.password, access)))
        return json({ error: "incorrect_password" }, 401);
      this.attempts.delete(address);
      return json({ ok: true }, 200, {
        "Set-Cookie": await makeSession(
          access,
          this.env.ADMIN_TOKEN,
          new URL(request.url).protocol === "https:",
        ),
      });
    }
    if (path === "/api/settings") {
      let body;
      try {
        body = await readBody(request);
      } catch {
        return json({ error: "invalid_request" }, 400);
      }
      if (typeof body.enabled !== "boolean")
        return json({ error: "invalid_request" }, 400);
      if (
        body.enabled &&
        (typeof body.password !== "string" ||
          body.password.length < 8 ||
          new TextEncoder().encode(body.password).length > 256)
      ) {
        return json({ error: "password_length" }, 400);
      }
      const next = body.enabled
        ? await createAccess(body.password)
        : { enabled: false, version: crypto.randomUUID() };
      await this.ctx.storage.put("access", next);
      this.attempts.clear();
      return json({ passwordRequired: next.enabled });
    }
    if (!(await controlAuthorized(request, access, this.env.ADMIN_TOKEN)))
      return json({ error: "password_required" }, 401);
    if (path === "/api/status") {
      const values = await this.ctx.storage.get(["command", "lastSeen"]);
      const lastSeen =
        Math.max(this.lastSeen, values.get("lastSeen") ?? 0) || null;
      const command = values.get("command") ?? null;
      const status =
        command?.status === "pending" && command.expiresAt <= now
          ? "expired"
          : command?.status;
      return json({
        online: lastSeen !== null && now - lastSeen < ONLINE_MS,
        lastSeen,
        command: command ? { ...command, status } : null,
        passwordRequired: access.enabled,
        serverTime: now,
      });
    }
    if (path === "/api/wake") {
      return this.ctx.storage.transaction(async (tx) => {
        const previous = await tx.get("command");
        if (previous?.status === "pending" && previous.expiresAt > now)
          return json({ error: "command_pending" }, 409);
        const seen = Math.max(this.lastSeen, (await tx.get("lastSeen")) ?? 0);
        if (now - seen >= ONLINE_MS)
          return json({ error: "device_offline" }, 409);
        if (previous && now - previous.issuedAt < 5000)
          return json({ error: "wake_cooldown" }, 429);
        const command = {
          id: crypto.randomUUID(),
          issuedAt: now,
          expiresAt: now + COMMAND_MS,
          status: "pending",
        };
        await tx.put("command", command);
        return json({ command }, 201);
      });
    }
    return json({ error: "not_found" }, 404);
  }

  async poll(request, now) {
    let body;
    try {
      body = await readBody(request);
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    if (
      (body.lastHandled !== undefined &&
        (typeof body.lastHandled !== "string" ||
          body.lastHandled.length > 64)) ||
      (body.lastResult !== undefined &&
        !["sent", "failed"].includes(body.lastResult))
    )
      return json({ error: "invalid_device_status" }, 400);
    this.lastSeen = now;
    return this.ctx.storage.transaction(async (tx) => {
      if (now - this.lastPersisted >= 30000) {
        await tx.put("lastSeen", now);
        this.lastPersisted = now;
      }
      const command = await tx.get("command");
      const response = { protocol: 1, serverTime: now, command: null };
      if (!command) return json(response);
      if (body.lastHandled === command.id && body.lastResult) {
        if (command.status === "pending") {
          command.status = body.lastResult;
          command.acknowledgedAt = now;
          await tx.put("command", command);
        }
      } else if (command.expiresAt > now && command.status === "pending") {
        response.command = { id: command.id, expiresAt: command.expiresAt };
      }
      return json(response);
    });
  }
}
