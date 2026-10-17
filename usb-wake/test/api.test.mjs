import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const owner = "owner-fixture-".repeat(4);
const device = "device-fixture-".repeat(4);

async function fixture(t, { open = true } = {}) {
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
          bindings: { ADMIN_TOKEN: owner, DEVICE_TOKEN: device },
          durableObjects: {
            WAKE_STATE: { className: "WakeState", useSQLite: true },
          },
        },
      ],
      host: "127.0.0.1",
      port: 16033,
    }),
  );
  t.after(() => mf.dispose());
  const call = (
    path,
    {
      token,
      body,
      cookie,
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
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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
    t.after(() => ws.close());
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
  if (open)
    assert.equal(
      (await call("/api/settings", { token: owner, body: { enabled: false } }))
        .status,
      200,
    );
  return call;
}

test("fresh deployments require a password the owner has not yet set", async (t) => {
  const call = await fixture(t, { open: false });
  assert.equal((await call("/api/status")).status, 401);
  assert.equal((await call("/api/wake", { body: {} })).status, 401);
  const login = await call("/api/login", { body: { password: "anything" } });
  assert.equal(login.status, 409);
  assert.equal((await login.json()).error, "password_not_set");
  const status = await call("/api/status", { token: owner });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).passwordRequired, true);
});

test("open access preserves device and owner authentication", async (t) => {
  const call = await fixture(t);
  assert.equal(
    (await (await call("/api/status")).json()).passwordRequired,
    false,
  );
  assert.equal((await call("/api/status")).status, 200);
  assert.equal((await call("/device/poll", { body: {} })).status, 401);
  assert.equal(
    (await call("/device/poll", { body: {}, token: owner })).status,
    401,
  );
  assert.equal(
    (await call("/api/settings", { body: { enabled: false }, token: device }))
      .status,
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

test("password can be enabled, changed and disabled by owner; sessions are invalidated", async (t) => {
  const call = await fixture(t);
  const settings = (body) => call("/api/settings", { token: owner, body });
  assert.equal(
    (await settings({ enabled: true, password: "short" })).status,
    400,
  );
  assert.equal(
    (await settings({ enabled: true, password: "correct-password" })).status,
    200,
  );
  assert.equal((await call("/api/status")).status, 401);
  assert.equal((await call("/api/status", { token: device })).status, 401);
  assert.equal((await call("/api/status", { token: owner })).status, 200);
  assert.equal(
    (await call("/api/login", { body: { password: "wrong" } })).status,
    401,
  );
  const login = await call("/api/login", {
    body: { password: "correct-password" },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("Set-Cookie");
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.equal((await call("/api/status", { cookie })).status, 200);
  assert.equal(
    (await call("/api/settings", { cookie, body: { enabled: false } })).status,
    401,
  );
  assert.equal(
    (
      await call("/api/status", {
        cookie: cookie.replace(/wake_session=./, "wake_session=X"),
      })
    ).status,
    401,
  );
  await settings({ enabled: true, password: "another-password" });
  assert.equal((await call("/api/status", { cookie })).status, 401);
  for (let i = 0; i < 8; i++)
    assert.equal(
      (await call("/api/login", { body: { password: "wrong" } })).status,
      401,
    );
  assert.equal(
    (await call("/api/login", { body: { password: "wrong" } })).status,
    429,
  );
  await settings({ enabled: false });
  assert.equal((await call("/api/status")).status, 200);
  await settings({ enabled: true, password: "correct-password" });
  for (let i = 0; i < 8; i++)
    assert.equal(
      (await call("/api/login", { body: { password: "wrong" } })).status,
      401,
    );
  // Settings changes reset the limiter, so the owner is never locked out.
  await settings({ enabled: false });
  assert.equal(
    (await (await call("/api/status")).json()).passwordRequired,
    false,
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
});

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
