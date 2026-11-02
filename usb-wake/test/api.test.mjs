import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { nextFire, parseSchedules } from "../cloud/src/schedule.js";

const owner = "owner-fixture-".repeat(4);
const device = "device-fixture-".repeat(4);
const password = "fixture-password";
const catalogue = [
  { id: "shutdown", label: "Shut down", confirm: true },
  { id: "start-notes", label: "Open notes" },
];

async function fixture(t, { accessPassword = password } = {}) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "entry",
          modules: true,
          scriptPath: "pages-entry/public/_worker.js",
          compatibilityDate: "2026-10-15",
          serviceBindings: { RELAY: "relay" },
        },
        {
          name: "relay",
          modules: true,
          scriptPath: "cloud/dist/index.js",
          compatibilityDate: "2026-10-15",
          bindings: {
            ADMIN_TOKEN: owner,
            DEVICE_TOKEN: device,
            ...(accessPassword ? { ACCESS_PASSWORD: accessPassword } : {}),
          },
          durableObjects: {
            WAKE_STATE: { className: "WakeState", useSQLite: true },
          },
        },
      ],
      host: "127.0.0.1",
      port: 16033,
    }),
  );
  t.onTestFinished(() => mf.dispose());
  let session;
  // Signed in as the web page unless a test passes its own token or cookie;
  // `cookie: false` sends no credentials at all. `rawBody` is sent as is.
  const call = (
    path,
    {
      token,
      body,
      rawBody,
      headers = {},
      cookie = token ? undefined : session,
      origin,
      method = body === undefined ? "GET" : "POST",
    } = {},
  ) =>
    mf.dispatchFetch(`https://wake.test${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...headers,
      },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  call.socket = async (token = device) => {
    const response = await mf.dispatchFetch("https://wake.test/device/socket", {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
    });
    if (response.status !== 101) return { status: response.status };
    const ws = response.webSocket;
    const queue = [];
    const waiting = [];
    ws.addEventListener("message", ({ data }) => {
      const parsed = data === "pong" ? data : JSON.parse(data);
      if (waiting.length) waiting.shift()(parsed);
      else queue.push(parsed);
    });
    const closed = new Promise((resolve) =>
      ws.addEventListener("close", ({ code }) => resolve(code)),
    );
    ws.accept();
    t.onTestFinished(() => ws.close());
    return {
      status: 101,
      closed,
      send: (value) =>
        ws.send(typeof value === "string" ? value : JSON.stringify(value)),
      next: () =>
        queue.length
          ? Promise.resolve(queue.shift())
          : new Promise((resolve) => waiting.push(resolve)),
    };
  };
  if (accessPassword) {
    const login = await call("/api/login", {
      body: { password: accessPassword },
      cookie: false,
    });
    assert.equal(login.status, 200);
    session = login.headers.get("Set-Cookie").split(";")[0];
  }
  return call;
}

test("without a configured password the page stays locked", async (t) => {
  const call = await fixture(t, { accessPassword: null });
  const status = await call("/api/status", { cookie: false });
  assert.equal(status.status, 401);
  assert.equal((await status.json()).error, "password_not_set");
  const login = await call("/api/login", {
    body: { password: "anything" },
    cookie: false,
  });
  assert.equal(login.status, 409);
  assert.equal((await call("/api/status", { token: owner })).status, 200);
});

test("the configured password unlocks a session; guessing is throttled", async (t) => {
  const call = await fixture(t);
  assert.equal((await call("/api/status", { cookie: false })).status, 401);
  assert.equal((await call("/api/status")).status, 200);
  assert.equal(
    (await call("/api/status", { cookie: "wake_session=X.1.Y" })).status,
    401,
  );
  assert.equal((await call("/api/status", { token: device })).status, 401);
  assert.equal((await call("/api/settings", { body: {} })).status, 404);
  const login = await call("/api/login", {
    body: { password },
    cookie: false,
  });
  const cookie = login.headers.get("Set-Cookie");
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.match(cookie, /Secure/);
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await call("/api/login", {
          body: { password: "wrong" },
          cookie: false,
        })
      ).status,
      401,
    );
  assert.equal(
    (await call("/api/login", { body: { password }, cookie: false })).status,
    429,
  );
});

test("device and owner credentials stay separate; requests are validated", async (t) => {
  const call = await fixture(t);
  assert.equal((await call("/device/poll", { body: {} })).status, 401);
  assert.equal(
    (await call("/device/poll", { body: {}, token: owner })).status,
    401,
  );
  assert.equal(
    (await call("/api/wake", { body: {}, origin: "https://other.test" }))
      .status,
    403,
  );
  assert.equal((await call("/api/wake", { method: "POST" })).status, 415);
  assert.equal((await call("/api/wake", { body: {} })).status, 409);
  assert.equal(
    (await call("/device/poll", { body: { lastHandled: 123 }, token: device }))
      .status,
    400,
  );
  assert.equal(
    (
      await call("/device/poll", {
        body: { lastHandled: "x".repeat(3000) },
        token: device,
      })
    ).status,
    400,
  );
});

test("commands are redelivered until acknowledged, deduplicated, then cooled down", async (t) => {
  const call = await fixture(t);
  const poll = (body) => call("/device/poll", { token: device, body });
  await poll({});
  const created = await call("/api/wake", { body: {} });
  assert.equal(created.status, 201);
  const { command } = await created.json();
  assert.equal(command.expiresAt - command.issuedAt, 30000);
  assert.equal((await call("/api/wake", { body: {} })).status, 409);
  for (let i = 0; i < 2; i++)
    assert.equal((await (await poll({})).json()).command.id, command.id);
  assert.equal(
    (await (await poll({ lastHandled: command.id, lastResult: "sent" })).json())
      .command,
    null,
  );
  assert.equal((await (await poll({})).json()).command, null);
  assert.equal(
    (await (await call("/api/status")).json()).command.status,
    "sent",
  );
  assert.equal((await call("/api/wake", { body: {} })).status, 429);
});

test("expired commands cannot wake after delayed reconnection", async (t) => {
  const call = await fixture(t);
  await call("/device/poll", { token: device, body: {} });
  await call("/api/wake", { body: {} });
  await new Promise((resolve) => setTimeout(resolve, 30500));
  assert.equal((await (await call("/api/status")).json()).online, false);
  const poll = await call("/device/poll", { token: device, body: {} });
  assert.equal((await poll.json()).command, null);
  assert.equal(
    (await (await call("/api/status")).json()).command.status,
    "expired",
  );
}, 60_000);

test("socket delivers commands immediately and accepts acknowledgements", async (t) => {
  const call = await fixture(t);
  assert.equal((await call.socket(owner)).status, 401);
  assert.equal((await call("/device/socket", { token: device })).status, 426);
  const board = await call.socket();
  board.send("ping");
  assert.equal(await board.next(), "pong");
  board.send({});
  assert.equal((await board.next()).command, null);
  assert.equal((await (await call("/api/status")).json()).online, true);
  const created = await call("/api/wake", { body: {} });
  assert.equal(created.status, 201);
  const { command } = await created.json();
  const pushed = await board.next();
  assert.deepEqual(pushed.command, {
    id: command.id,
    expiresAt: command.expiresAt,
  });
  board.send({ lastHandled: command.id, lastResult: "failed" });
  assert.equal((await board.next()).command, null);
  assert.equal(
    (await (await call("/api/status")).json()).command.status,
    "failed",
  );
  board.send({ lastHandled: 5 });
  assert.equal(await board.closed, 1008);
});

test("a reconnecting board replaces its old socket and receives pending work", async (t) => {
  const call = await fixture(t);
  const first = await call.socket();
  first.send({});
  await first.next();
  const { command } = await (await call("/api/wake", { body: {} })).json();
  await first.next();
  const second = await call.socket();
  assert.equal(await first.closed, 1012);
  second.send({ lastHandled: "older-command", lastResult: "sent" });
  assert.equal((await second.next()).command.id, command.id);
  assert.equal((await (await call("/api/status")).json()).online, true);
});

test("PC actions come from the agent's catalogue and reach the board", async (t) => {
  const call = await fixture(t);
  const board = await call.socket();
  board.send({ pc: { online: false, actions: catalogue } });
  await board.next();
  let status = await (await call("/api/status")).json();
  assert.equal(status.pc.agent, false);
  assert.deepEqual(status.pc.actions, [
    { id: "shutdown", label: "Shut down", confirm: true },
    { id: "start-notes", label: "Open notes", confirm: false },
  ]);
  const offline = await call("/api/action", { body: { action: "shutdown" } });
  assert.equal(offline.status, 409);
  assert.equal((await offline.json()).error, "pc_offline");
  // Online updates without a catalogue keep the one already stored.
  board.send({ pc: { online: true } });
  await board.next();
  status = await (await call("/api/status")).json();
  assert.equal(status.pc.agent, true);
  assert.equal(status.pc.actions.length, 2);
  assert.equal(
    (await call("/api/action", { body: { action: "format-disk" } })).status,
    404,
  );
  assert.equal(
    (await call("/api/action", { body: { action: "Bad Id" } })).status,
    400,
  );
  const created = await call("/api/action", { body: { action: "shutdown" } });
  assert.equal(created.status, 201);
  const { command } = await created.json();
  assert.equal(command.label, "Shut down");
  assert.deepEqual((await board.next()).command, {
    id: command.id,
    expiresAt: command.expiresAt,
    action: "shutdown",
  });
  board.send({ lastHandled: command.id, lastResult: "unreachable" });
  await board.next();
  status = await (await call("/api/status")).json();
  assert.equal(status.command.kind, "action");
  assert.equal(status.command.status, "unreachable");
  board.send({ pc: { online: true, actions: [{ id: "x", label: "" }] } });
  assert.equal(await board.closed, 1008);
});

test("power reports are logged and a wake is tracked until the PC is on", async (t) => {
  const call = await fixture(t);
  const board = await call.socket();
  const state = async (body) => {
    board.send(body);
    return board.next();
  };
  await state({ pc: { online: false, power: "off" } });
  const { command } = await (await call("/api/wake", { body: {} })).json();
  await board.next();
  await state({ lastHandled: command.id, lastResult: "sent" });
  let status = await (await call("/api/status")).json();
  assert.ok(status.wake.deadline > status.wake.sentAt);
  assert.equal(status.events[0].text, "Wake packets sent");
  await state({
    lastHandled: command.id,
    lastResult: "sent",
    pc: { online: false, power: "on" },
  });
  status = await (await call("/api/status")).json();
  assert.equal(status.pc.power, "on");
  assert.equal(status.wake, null);
  assert.equal(status.events[0].type, "pc_woke");
  board.send({ pc: { online: false, power: "sideways" } });
  assert.equal(await board.closed, 1008);
});

test("an off-on cycle without a page action is reported as a restart", async (t) => {
  const call = await fixture(t);
  const board = await call.socket();
  for (const power of ["on", "off", "on"]) {
    board.send({ pc: { online: false, power } });
    await board.next();
  }
  const types = (await (await call("/api/status")).json()).events.map(
    (event) => event.type,
  );
  assert.deepEqual(types, ["pc_restarted", "pc_off"]);
});

test("board telemetry is stored and invalid fields are dropped", async (t) => {
  const call = await fixture(t);
  const board = await call.socket();
  board.send({
    board: {
      temperature: 40.5,
      rssi: -52,
      uptime: 120,
      firmware: "zz",
      build: "2026-10-23 07:32",
    },
  });
  await board.next();
  const status = await (await call("/api/status")).json();
  assert.equal(status.board.build, "2026-10-23 07:32");
  assert.equal(status.board.temperature, 40.5);
  assert.equal(status.board.rssi, -52);
  assert.equal(status.board.firmware, undefined);
  board.send({ board: "hot" });
  assert.equal(await board.closed, 1008);
});

test("the LED level is pushed, repeated in replies and echoed back", async (t) => {
  const call = await fixture(t);
  assert.equal(
    (await call("/api/board", { body: { led: "blinding" } })).status,
    400,
  );
  const board = await call.socket();
  board.send({});
  assert.equal((await board.next()).settings, undefined);
  const saved = await call("/api/board", { body: { led: "off" } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await board.next()).settings, { led: "off" });
  board.send({ board: { led: "off" } });
  assert.deepEqual((await board.next()).settings, { led: "off" });
  const status = await (await call("/api/status")).json();
  assert.deepEqual(status.settings, { led: "off" });
  assert.equal(status.board.led, "off");
});

test("firmware uploads need the management key and reach the board intact", async (t) => {
  const call = await fixture(t);
  const body = new Uint8Array(300_000).map((_, i) => (i * 7) % 251);
  const digest = createHash("sha256").update(body).digest();
  const image = new Uint8Array([...body, ...digest]);
  const hex = digest.toString("hex");
  const upload = (token, data = image, header = hex) =>
    call("/api/firmware", {
      token,
      method: "PUT",
      rawBody: data,
      headers: { "X-Firmware-Digest": header },
    });
  assert.equal((await upload(undefined)).status, 401);
  assert.equal((await upload(device)).status, 401);
  assert.equal((await upload(owner, image, "0".repeat(64))).status, 400);
  assert.equal((await upload(owner, image.slice(0, -1))).status, 400);
  assert.equal((await upload(owner)).status, 201);
  const download = await call("/device/firmware", { token: device });
  assert.equal(download.headers.get("X-Firmware-Digest"), hex);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), image);
  const board = await call.socket();
  board.send({ board: { firmware: hex } });
  assert.equal((await board.next()).firmware.digest, hex);
  const status = await (await call("/api/status")).json();
  assert.equal(status.events[0].type, "firmware_updated");
  assert.equal(
    (await call("/api/firmware", { token: owner, method: "DELETE" })).status,
    200,
  );
  assert.equal((await call("/device/firmware", { token: device })).status, 404);
});

test("schedules are validated and fire at the next matching local time", async (t) => {
  const call = await fixture(t);
  const weekdays = { time: "08:00", days: [1, 2, 3, 4, 5], enabled: true };
  assert.equal(
    (
      await call("/api/schedules", {
        body: { schedules: [{ ...weekdays, time: "25:00" }] },
      })
    ).status,
    400,
  );
  const saved = await call("/api/schedules", {
    body: { schedules: [weekdays] },
  });
  assert.equal(saved.status, 200);
  const status = await (await call("/api/status")).json();
  assert.equal(status.schedules.length, 1);
  assert.ok(status.nextWake > status.serverTime);
  // Friday 23 Oct 2026, 09:00 in Shanghai: next is Monday 08:00 (00:00 UTC).
  assert.equal(
    nextFire(weekdays, Date.UTC(2026, 9, 23, 1), "Asia/Shanghai"),
    Date.UTC(2026, 9, 26, 0),
  );
  // Same day when the time is still ahead.
  assert.equal(
    nextFire(weekdays, Date.UTC(2026, 9, 22, 23), "Asia/Shanghai"),
    Date.UTC(2026, 9, 23, 0),
  );
  // Across a DST change: 08:00 EDT on Sunday 8 Mar 2026 is 12:00 UTC.
  assert.equal(
    nextFire(
      { time: "08:00", days: [0], enabled: true },
      Date.UTC(2026, 2, 7, 12),
      "America/New_York",
    ),
    Date.UTC(2026, 2, 8, 12),
  );
  assert.equal(nextFire({ ...weekdays, enabled: false }, 0, "UTC"), null);
  assert.equal(parseSchedules([{ ...weekdays, days: [7] }]), null);
});
