import {
  configuredPassword,
  controlAuthorized,
  makeSession,
  passwordMatches,
} from "./auth.js";
import { record } from "./events.js";
import { clear, download, imageDigest, store } from "./firmware.js";
import { json, readBody } from "./http.js";
import { nextFire, parseSchedules } from "./schedule.js";

const POLL_ONLINE_MS = 20000;
// The board pings every 20 seconds; two missed pings mean the link is gone.
const SOCKET_ONLINE_MS = 50000;
const COMMAND_MS = 30000;
const COOLDOWN_MS = 5000;
// A woken PC must report "on" within this long or the wake counts as failed.
const WAKE_TIMEOUT_MS = 120000;
// Off then on again this quickly, with no page action, is reported as a restart.
const RESTART_WINDOW_MS = 180000;
// Power changes this soon after a page action are treated as requested.
const ACTION_GRACE_MS = 180000;
const BOARD_OFFLINE_NOTICE_MS = 120000;
// Catches half-open sockets, whose pings stop without a close event.
const WATCHDOG_MS = 120000;
const LOGIN_WINDOW_MS = 60000;
const LOGIN_LIMIT = 8;
// Caps guessing even when every attempt comes from a new address.
const LOGIN_GLOBAL_LIMIT = 60;
// Mirrors the catalogue limits in tools/agent.py.
const MAX_ACTIONS = 16;
const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_LABEL = 40;
const RESULTS = ["sent", "failed", "unreachable"];
const POWER = ["on", "sleep", "off"];
// Mirrors kLedNames in firmware/src/config.h.
const LED_LEVELS = ["off", "low", "medium", "high"];
const EVENTS_SHOWN = 20;

export class WakeState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.timeZone = env.TIMEZONE || "Asia/Shanghai";
    this.lastSeen = 0;
    this.lastPersisted = 0;
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  log(type, text, level) {
    return record(this.ctx, this.env, type, text, level);
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const now = Date.now();
    if (path === "/api/firmware") {
      if (request.method === "PUT") return this.uploadFirmware(request, now);
      await clear(this.storage);
      return json({ ok: true });
    }
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
    if (path === "/device/firmware") return download(this.storage);
    if (path === "/api/login") return this.login(request, body, now);
    if (!(await controlAuthorized(request, this.env)))
      return json(
        {
          error: configuredPassword(this.env)
            ? "password_required"
            : "password_not_set",
        },
        401,
      );
    if (path === "/api/status") return json(await this.status(now));
    if (path === "/api/wake")
      return this.respond(await this.issue({ kind: "wake" }, now));
    if (path === "/api/action") {
      if (typeof body.action !== "string" || !ACTION_ID.test(body.action))
        return json({ error: "invalid_request" }, 400);
      return this.respond(
        await this.issue({ kind: "action", action: body.action }, now),
      );
    }
    if (path === "/api/schedules") {
      const schedules = parseSchedules(body.schedules);
      if (!schedules) return json({ error: "invalid_schedule" }, 400);
      await this.storage.put({ schedules, scheduleCheckedAt: now });
      await this.armAlarm(now);
      return json({ schedules });
    }
    // Stored, pushed now, and repeated in every reply so a board that was
    // offline catches up when it reconnects.
    if (path === "/api/board") {
      if (!LED_LEVELS.includes(body.led))
        return json({ error: "invalid_request" }, 400);
      const settings = { led: body.led };
      await this.storage.put("settings", settings);
      this.broadcast({ settings }, now);
      return json({ settings });
    }
    return json({ error: "not_found" }, 404);
  }

  respond(result) {
    return result.error
      ? json({ error: result.error }, result.status)
      : json({ command: result.command }, 201);
  }

  async login(request, body, now) {
    if (!configuredPassword(this.env))
      return json({ error: "password_not_set" }, 409);
    const address = request.headers.get("CF-Connecting-IP") ?? "local";
    if (!(await this.allowLogin(address, now)))
      return json({ error: "too_many_attempts" }, 429, { "Retry-After": "60" });
    if (!(await passwordMatches(body.password, this.env)))
      return json({ error: "incorrect_password" }, 401);
    await this.storage.delete(`login:${address}`);
    return json({ ok: true }, 200, {
      "Set-Cookie": await makeSession(
        this.env,
        new URL(request.url).protocol === "https:",
      ),
    });
  }

  async status(now) {
    const values = await this.storage.get([
      "command",
      "pc",
      "board",
      "events",
      "schedules",
      "wake",
      "firmware",
      "settings",
    ]);
    const command = values.get("command");
    const pc = values.get("pc");
    const schedules = values.get("schedules") ?? [];
    const firmware = values.get("firmware");
    const { online, lastSeen } = await this.presence(now);
    const upcoming = schedules
      .map((schedule) => nextFire(schedule, now, this.timeZone))
      .filter((at) => at !== null);
    return {
      online,
      lastSeen,
      pc: {
        agent: online && Boolean(pc?.online),
        power: online ? (pc?.power ?? null) : null,
        actions: pc?.actions ?? [],
      },
      board: online ? (values.get("board") ?? null) : null,
      settings: values.get("settings") ?? {},
      command: command
        ? {
            ...command,
            status:
              command.status === "pending" && command.expiresAt <= now
                ? "expired"
                : command.status,
          }
        : null,
      wake: values.get("wake") ?? null,
      events: (values.get("events") ?? []).slice(0, EVENTS_SHOWN),
      schedules,
      nextWake: upcoming.length ? Math.min(...upcoming) : null,
      timeZone: this.timeZone,
      firmware: firmware
        ? { digest: firmware.digest, size: firmware.size }
        : null,
      serverTime: now,
    };
  }

  // Only one command may be in flight at a time.
  async issue(request, now) {
    const { online } = await this.presence(now);
    const previous = await this.storage.get("command");
    if (previous?.status === "pending" && previous.expiresAt > now)
      return { error: "command_pending", status: 409 };
    if (!online) return { error: "device_offline", status: 409 };
    if (previous && now - previous.issuedAt < COOLDOWN_MS)
      return { error: "cooldown", status: 429 };
    const command = {
      id: crypto.randomUUID(),
      kind: request.kind,
      issuedAt: now,
      expiresAt: now + COMMAND_MS,
      status: "pending",
      ...(request.source ? { source: request.source } : {}),
    };
    if (request.kind === "action") {
      const pc = await this.storage.get("pc");
      const action = pc?.actions?.find((item) => item.id === request.action);
      if (!action) return { error: "unknown_action", status: 404 };
      if (!pc.online) return { error: "pc_offline", status: 409 };
      command.action = action.id;
      command.label = action.label;
      await this.storage.put("lastActionAt", now);
    }
    await this.storage.put("command", command);
    this.broadcast({ command: this.delivery(command) }, now);
    return { command };
  }

  // What the board receives. Commands without `action` are wake requests,
  // which keeps older firmware working.
  delivery(command) {
    return {
      id: command.id,
      expiresAt: command.expiresAt,
      ...(command.action ? { action: command.action } : {}),
    };
  }

  broadcast(message, now) {
    const text = JSON.stringify({ protocol: 1, serverTime: now, ...message });
    for (const socket of this.deviceSockets()) {
      try {
        socket.send(text);
      } catch {
        // A dead socket is dropped by its close handler; the board also
        // fetches pending work whenever it reconnects.
      }
    }
  }

  async uploadFirmware(request, now) {
    const image = await request.arrayBuffer();
    const digest = await imageDigest(image);
    if (!digest || digest !== request.headers.get("X-Firmware-Digest"))
      return json({ error: "invalid_image" }, 400);
    const meta = await store(this.storage, image, digest);
    await this.log(
      "firmware_uploaded",
      `Firmware ${digest.slice(0, 8)} uploaded`,
    );
    this.broadcast({ firmware: { digest, size: meta.size } }, now);
    return json({ firmware: { digest, size: meta.size } }, 201);
  }

  async allowLogin(address, now) {
    const key = `login:${address}`;
    const [attempt, global] = await Promise.all([
      this.storage.get(key),
      this.storage.get("login-global"),
    ]);
    const fresh = (entry) =>
      entry && now - entry.at < LOGIN_WINDOW_MS ? entry : { at: now, count: 0 };
    const all = fresh(global);
    // A new global window also prunes per-address entries left by old windows.
    const own = all === global ? fresh(attempt) : { at: now, count: 0 };
    if (all !== global) await this.clearLogins();
    own.count += 1;
    all.count += 1;
    await this.storage.put({ [key]: own, "login-global": all });
    return own.count <= LOGIN_LIMIT && all.count <= LOGIN_GLOBAL_LIMIT;
  }

  async clearLogins() {
    const keys = [
      ...(await this.storage.list({ prefix: "login:" })).keys(),
      "login-global",
    ];
    await this.storage.delete(keys);
  }

  deviceSockets() {
    return this.ctx
      .getWebSockets("device")
      .filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  socketSeen(socket) {
    return Math.max(
      this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0,
      socket.deserializeAttachment()?.at ?? 0,
    );
  }

  // Old firmware polls over HTTP; current firmware holds a WebSocket and pings.
  async presence(now) {
    const polled = Math.max(
      this.lastSeen,
      (await this.storage.get("lastSeen")) ?? 0,
    );
    const socket = Math.max(
      0,
      ...this.deviceSockets().map((ws) => this.socketSeen(ws)),
    );
    return {
      online: now - polled < POLL_ONLINE_MS || now - socket < SOCKET_ONLINE_MS,
      lastSeen: Math.max(polled, socket) || null,
    };
  }

  async connect(request, now) {
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
    const board = await this.storage.get("boardState");
    if (board?.online === false && board.notified)
      await this.log("board_back", "Wake board back online", "good");
    await this.storage.put("boardState", { online: true, since: now });
    await this.armAlarm(now);
    return new Response(null, { status: 101, webSocket: client });
  }

  async boardDown(now) {
    const board = await this.storage.get("boardState");
    if (board?.online === false) return;
    await this.storage.put("boardState", {
      online: false,
      since: now,
      notified: false,
    });
    await this.armAlarm(now);
  }

  async webSocketMessage(socket, message) {
    const now = Date.now();
    socket.serializeAttachment({ at: now });
    if (typeof message !== "string" || message.length > 4096) {
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

  async webSocketClose(socket, code) {
    try {
      socket.close(code === 1000 ? 1000 : 1011, "closed");
    } catch {
      // The runtime may already have completed the close handshake.
    }
    if (this.deviceSockets().length === 0) await this.boardDown(Date.now());
  }

  async poll(body, now) {
    this.lastSeen = now;
    if (now - this.lastPersisted >= 30000) {
      await this.storage.put("lastSeen", now);
      this.lastPersisted = now;
    }
    const reply = await this.exchange(body, now);
    return reply ? json(reply) : json({ error: "invalid_device_status" }, 400);
  }

  // Shared by HTTP polling (older firmware) and the WebSocket: the board
  // reports the last command it handled, the PC's state and its own
  // telemetry; it receives any undelivered command and the offered firmware.
  async exchange(body, now) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      (body.lastHandled !== undefined &&
        (typeof body.lastHandled !== "string" ||
          body.lastHandled.length > 64)) ||
      (body.lastResult !== undefined && !RESULTS.includes(body.lastResult))
    )
      return null;
    const pc = body.pc === undefined ? undefined : parsePc(body.pc);
    const board = body.board === undefined ? undefined : parseBoard(body.board);
    if (pc === null || board === null) return null;
    const stored = await this.storage.get(["firmware", "settings"]);
    const firmware = stored.get("firmware");
    const settings = stored.get("settings");
    if (pc) await this.updatePc(pc, now);
    if (board) await this.updateBoard(board, firmware, now);
    const response = { protocol: 1, serverTime: now, command: null };
    if (firmware)
      response.firmware = { digest: firmware.digest, size: firmware.size };
    if (settings) response.settings = settings;
    const command = await this.storage.get("command");
    if (!command) return response;
    if (body.lastHandled === command.id && body.lastResult) {
      if (command.status === "pending") {
        command.status = body.lastResult;
        command.acknowledgedAt = now;
        await this.storage.put("command", command);
        await this.finished(command, now);
      }
    } else if (command.expiresAt > now && command.status === "pending") {
      response.command = this.delivery(command);
    }
    return response;
  }

  async finished(command, now) {
    if (command.kind === "action") {
      const sent = command.status === "sent";
      const text = {
        sent: `Sent to PC: ${command.label}`,
        failed: `PC could not run: ${command.label}`,
        unreachable: `PC did not respond: ${command.label}`,
      }[command.status];
      await this.log(
        sent ? "action_sent" : "action_failed",
        text,
        sent ? "good" : "warn",
      );
      return;
    }
    if (command.status !== "sent") {
      await this.log(
        "wake_failed",
        "Wake failed: the board could not send packets",
        "warn",
      );
      return;
    }
    await this.log(
      "wake_sent",
      command.source === "schedule"
        ? "Scheduled wake sent"
        : "Wake packets sent",
    );
    await this.storage.put("wake", {
      sentAt: now,
      deadline: now + WAKE_TIMEOUT_MS,
    });
    await this.armAlarm(now);
  }

  async updatePc(update, now) {
    const previous = (await this.storage.get("pc")) ?? {};
    const next = {
      online: update.online,
      power: update.power ?? previous.power ?? null,
      actions: update.actions ?? previous.actions ?? [],
      powerAt: previous.powerAt ?? null,
      offAt: previous.offAt ?? null,
    };
    if (update.power && update.power !== previous.power) {
      next.powerAt = now;
      await this.powerChanged(previous.power, update.power, next, now);
    }
    await this.storage.put("pc", next);
  }

  async powerChanged(from, to, next, now) {
    if (to !== "on") {
      if (to === "off") next.offAt = now;
      if (from)
        await this.log(
          `pc_${to}`,
          to === "sleep" ? "PC went to sleep" : "PC turned off",
        );
      return;
    }
    const wake = await this.storage.get("wake");
    const lastAction = (await this.storage.get("lastActionAt")) ?? 0;
    if (wake) {
      const seconds = Math.round((now - wake.sentAt) / 1000);
      await this.log("pc_woke", `PC woke up after ${seconds} s`, "good");
      await this.storage.delete("wake");
    } else if (
      from === "off" &&
      next.offAt &&
      now - next.offAt < RESTART_WINDOW_MS &&
      now - lastAction >= ACTION_GRACE_MS
    ) {
      await this.log(
        "pc_restarted",
        "PC restarted without a request from this page",
        "warn",
      );
    } else if (from) {
      await this.log("pc_on", "PC turned on");
    }
    next.offAt = null;
  }

  async updateBoard(board, firmware, now) {
    await this.storage.put("board", { ...board, at: now });
    if (
      firmware &&
      board.firmware === firmware.digest &&
      !firmware.installedAt
    ) {
      await this.storage.put("firmware", { ...firmware, installedAt: now });
      await this.log(
        "firmware_updated",
        `Firmware updated to ${firmware.digest.slice(0, 8)}`,
        "good",
      );
    }
  }

  async alarm() {
    const now = Date.now();
    for (const socket of this.deviceSockets()) {
      if (now - this.socketSeen(socket) < SOCKET_ONLINE_MS) continue;
      try {
        socket.close(1011, "silent");
      } catch {
        // Already closing.
      }
    }
    let board = await this.storage.get("boardState");
    if (board?.online && this.deviceSockets().length === 0) {
      await this.boardDown(now);
      board = await this.storage.get("boardState");
    }
    if (
      board?.online === false &&
      !board.notified &&
      now - board.since >= BOARD_OFFLINE_NOTICE_MS
    ) {
      await this.storage.put("boardState", { ...board, notified: true });
      await this.log(
        "board_offline",
        "Wake board offline for 2 minutes",
        "warn",
      );
    }
    const wake = await this.storage.get("wake");
    if (wake && now >= wake.deadline) {
      await this.storage.delete("wake");
      await this.log(
        "wake_timeout",
        "PC did not turn on within 2 minutes of the wake",
        "warn",
      );
    }
    await this.runSchedules(now);
    await this.armAlarm(now);
  }

  async runSchedules(now) {
    const schedules = (await this.storage.get("schedules")) ?? [];
    const checked = (await this.storage.get("scheduleCheckedAt")) ?? now;
    await this.storage.put("scheduleCheckedAt", now);
    const due = schedules.some((schedule) => {
      const at = nextFire(schedule, checked, this.timeZone);
      return at !== null && at <= now;
    });
    if (!due) return;
    const pc = await this.storage.get("pc");
    const { online } = await this.presence(now);
    if (online && pc?.power === "on") {
      await this.log("schedule_noop", "Scheduled wake: PC was already on");
      return;
    }
    const result = await this.issue({ kind: "wake", source: "schedule" }, now);
    if (result.error)
      await this.log(
        "schedule_skipped",
        result.error === "device_offline"
          ? "Scheduled wake skipped: wake board offline"
          : "Scheduled wake skipped: another request was in progress",
        "warn",
      );
  }

  async armAlarm(now) {
    const values = await this.storage.get(["schedules", "wake", "boardState"]);
    const times = (values.get("schedules") ?? [])
      .map((schedule) => nextFire(schedule, now, this.timeZone))
      .filter((at) => at !== null);
    const wake = values.get("wake");
    if (wake) times.push(wake.deadline);
    const board = values.get("boardState");
    if (board?.online === false && !board.notified)
      times.push(board.since + BOARD_OFFLINE_NOTICE_MS);
    if (this.deviceSockets().length) times.push(now + WATCHDOG_MS);
    if (times.length)
      await this.storage.setAlarm(Math.max(Math.min(...times), now + 1000));
    else await this.storage.deleteAlarm();
  }
}

function parsePc(value) {
  if (!value || typeof value !== "object" || typeof value.online !== "boolean")
    return null;
  if (value.power !== undefined && !POWER.includes(value.power)) return null;
  const result = { online: value.online };
  if (value.power) result.power = value.power;
  if (value.actions === undefined) return result;
  if (!Array.isArray(value.actions) || value.actions.length > MAX_ACTIONS)
    return null;
  result.actions = [];
  for (const item of value.actions) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !ACTION_ID.test(item.id) ||
      typeof item.label !== "string" ||
      item.label.length < 1 ||
      item.label.length > MAX_LABEL ||
      (item.confirm !== undefined && typeof item.confirm !== "boolean")
    )
      return null;
    result.actions.push({
      id: item.id,
      label: item.label,
      confirm: item.confirm === true,
    });
  }
  return result;
}

// Board telemetry; every field is optional so firmware can add or drop some.
function parseBoard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const number = (key, min, max) =>
    typeof value[key] === "number" &&
    Number.isFinite(value[key]) &&
    value[key] >= min &&
    value[key] <= max
      ? value[key]
      : undefined;
  return {
    temperature: number("temperature", -40, 150),
    rssi: number("rssi", -127, 0),
    uptime: number("uptime", 0, 1e9),
    heap: number("heap", 0, 1e8),
    firmware:
      typeof value.firmware === "string" &&
      /^[0-9a-f]{64}$/.test(value.firmware)
        ? value.firmware
        : undefined,
    build:
      typeof value.build === "string" && /^[\w :.-]{1,32}$/.test(value.build)
        ? value.build
        : undefined,
    led: LED_LEVELS.includes(value.led) ? value.led : undefined,
  };
}
