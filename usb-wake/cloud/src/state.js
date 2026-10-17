import {
  controlAuthorized,
  createAccess,
  makeSession,
  passwordMatches,
} from "./auth.js";
import { json, readBody } from "./http.js";

const POLL_ONLINE_MS = 20000;
// The board pings every 20 seconds; two missed pings mean the link is gone.
const SOCKET_ONLINE_MS = 50000;
const COMMAND_MS = 30000;
const LOGIN_WINDOW_MS = 60000;
const LOGIN_LIMIT = 8;
// Bounds PBKDF2 work even when every attempt comes from a new address.
const LOGIN_GLOBAL_LIMIT = 60;
// Fresh deployments stay locked until the owner sets a password in Settings.
const DEFAULT_ACCESS = { enabled: true, version: "unset" };

export class WakeState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.lastSeen = 0;
    this.lastPersisted = 0;
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const now = Date.now();
    const access = (await this.ctx.storage.get("access")) ?? DEFAULT_ACCESS;
    // Every POST is read in full: workerd drops the keep-alive connection
    // when a response leaves the request body unread.
    let body = {};
    if (request.method === "POST") {
      try {
        body = await readBody(request);
      } catch {
        return json({ error: "invalid_request" }, 400);
      }
    }
    if (path === "/api/logout")
      return json({ ok: true }, 200, {
        "Set-Cookie":
          "wake_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure",
      });
    if (path === "/device/socket") return this.connect(request, now);
    if (path === "/device/poll") return this.poll(body, now);
    if (path === "/api/login") {
      if (!access.enabled) return json({ ok: true });
      if (!access.hash) return json({ error: "password_not_set" }, 409);
      const address = request.headers.get("CF-Connecting-IP") ?? "local";
      if (!(await this.allowLogin(address, now)))
        return json({ error: "too_many_attempts" }, 429, {
          "Retry-After": "60",
        });
      if (!(await passwordMatches(body.password, access)))
        return json({ error: "incorrect_password" }, 401);
      await this.ctx.storage.delete(`login:${address}`);
      return json({ ok: true }, 200, {
        "Set-Cookie": await makeSession(
          access,
          this.env.ADMIN_TOKEN,
          new URL(request.url).protocol === "https:",
        ),
      });
    }
    if (path === "/api/settings") {
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
      await this.clearLogins();
      return json({ passwordRequired: next.enabled });
    }
    if (!(await controlAuthorized(request, access, this.env.ADMIN_TOKEN)))
      return json({ error: "password_required" }, 401);
    if (path === "/api/status") {
      const command = (await this.ctx.storage.get("command")) ?? null;
      const status =
        command?.status === "pending" && command.expiresAt <= now
          ? "expired"
          : command?.status;
      const { online, lastSeen } = await this.presence(now);
      return json({
        online,
        lastSeen,
        command: command ? { ...command, status } : null,
        passwordRequired: access.enabled,
        serverTime: now,
      });
    }
    if (path === "/api/wake") {
      const { online } = await this.presence(now);
      const result = await this.ctx.storage.transaction(async (tx) => {
        const previous = await tx.get("command");
        if (previous?.status === "pending" && previous.expiresAt > now)
          return { error: "command_pending", status: 409 };
        if (!online) return { error: "device_offline", status: 409 };
        if (previous && now - previous.issuedAt < 5000)
          return { error: "wake_cooldown", status: 429 };
        const command = {
          id: crypto.randomUUID(),
          issuedAt: now,
          expiresAt: now + COMMAND_MS,
          status: "pending",
        };
        await tx.put("command", command);
        return { command };
      });
      if (result.error) return json({ error: result.error }, result.status);
      const push = JSON.stringify({
        protocol: 1,
        serverTime: now,
        command: { id: result.command.id, expiresAt: result.command.expiresAt },
      });
      for (const socket of this.deviceSockets()) {
        try {
          socket.send(push);
        } catch {
          // A dead socket is dropped by its close handler; the board also
          // fetches pending commands whenever it reconnects.
        }
      }
      return json({ command: result.command }, 201);
    }
    return json({ error: "not_found" }, 404);
  }

  async allowLogin(address, now) {
    const key = `login:${address}`;
    const [attempt, global] = await Promise.all([
      this.ctx.storage.get(key),
      this.ctx.storage.get("login-global"),
    ]);
    const fresh = (entry) =>
      entry && now - entry.at < LOGIN_WINDOW_MS ? entry : { at: now, count: 0 };
    const all = fresh(global);
    // A new global window also prunes per-address entries left by old windows.
    const own = all === global ? fresh(attempt) : { at: now, count: 0 };
    if (all !== global) await this.clearLogins();
    own.count += 1;
    all.count += 1;
    await this.ctx.storage.put({ [key]: own, "login-global": all });
    return own.count <= LOGIN_LIMIT && all.count <= LOGIN_GLOBAL_LIMIT;
  }

  async clearLogins() {
    const keys = [
      ...(await this.ctx.storage.list({ prefix: "login:" })).keys(),
      "login-global",
    ];
    await this.ctx.storage.delete(keys);
  }

  deviceSockets() {
    return this.ctx
      .getWebSockets("device")
      .filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  // Old firmware polls over HTTP; current firmware holds a WebSocket and pings.
  async presence(now) {
    const polled = Math.max(
      this.lastSeen,
      (await this.ctx.storage.get("lastSeen")) ?? 0,
    );
    const socket = Math.max(
      0,
      ...this.deviceSockets().map((ws) =>
        Math.max(
          this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0,
          ws.deserializeAttachment()?.at ?? 0,
        ),
      ),
    );
    return {
      online: now - polled < POLL_ONLINE_MS || now - socket < SOCKET_ONLINE_MS,
      lastSeen: Math.max(polled, socket) || null,
    };
  }

  connect(request, now) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return json({ error: "websocket_required" }, 426);
    for (const socket of this.ctx.getWebSockets("device")) {
      try {
        socket.close(1012, "replaced");
      } catch {
        // Already closing.
      }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["device"]);
    server.serializeAttachment({ at: now });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    const now = Date.now();
    socket.serializeAttachment({ at: now });
    if (typeof message !== "string" || message.length > 2048) {
      socket.close(1003, "invalid_message");
      return;
    }
    let body;
    try {
      body = JSON.parse(message);
    } catch {
      socket.close(1007, "invalid_message");
      return;
    }
    const reply = await this.exchange(body, now);
    if (!reply) {
      socket.close(1008, "invalid_device_status");
      return;
    }
    socket.send(JSON.stringify(reply));
  }

  webSocketClose(socket, code) {
    try {
      socket.close(code === 1000 ? 1000 : 1011, "closed");
    } catch {
      // The runtime may already have completed the close handshake.
    }
  }

  async poll(body, now) {
    this.lastSeen = now;
    if (now - this.lastPersisted >= 30000) {
      await this.ctx.storage.put("lastSeen", now);
      this.lastPersisted = now;
    }
    const reply = await this.exchange(body, now);
    return reply ? json(reply) : json({ error: "invalid_device_status" }, 400);
  }

  // Shared by HTTP polling (older firmware) and the WebSocket: the board
  // reports the last command it handled and receives any undelivered one.
  async exchange(body, now) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      (body.lastHandled !== undefined &&
        (typeof body.lastHandled !== "string" ||
          body.lastHandled.length > 64)) ||
      (body.lastResult !== undefined &&
        !["sent", "failed"].includes(body.lastResult))
    )
      return null;
    return this.ctx.storage.transaction(async (tx) => {
      const command = await tx.get("command");
      const response = { protocol: 1, serverTime: now, command: null };
      if (!command) return response;
      if (body.lastHandled === command.id && body.lastResult) {
        if (command.status === "pending") {
          command.status = body.lastResult;
          command.acknowledgedAt = now;
          await tx.put("command", command);
        }
      } else if (command.expiresAt > now && command.status === "pending") {
        response.command = { id: command.id, expiresAt: command.expiresAt };
      }
      return response;
    });
  }
}
