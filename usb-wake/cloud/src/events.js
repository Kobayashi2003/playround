// Activity log shown on the page, plus optional push notifications.

const MAX_EVENTS = 40;

// Event types that also go to NOTIFY_URL when it is set.
const NOTIFY = new Set([
  "pc_woke",
  "wake_timeout",
  "pc_restarted",
  "board_offline",
  "board_back",
  "action_failed",
  "schedule_skipped",
]);

export async function record(ctx, env, type, text, level = "info") {
  const events = (await ctx.storage.get("events")) ?? [];
  events.unshift({ at: Date.now(), type, text, level });
  await ctx.storage.put("events", events.slice(0, MAX_EVENTS));
  if (NOTIFY.has(type) && env.NOTIFY_URL)
    ctx.waitUntil(notify(env.NOTIFY_URL, text).catch(() => {}));
}

// NOTIFY_URL picks the format: Bark (api.day.app/<key>), ServerChan
// (sctapi.ftqq.com/<key>.send), otherwise ntfy (ntfy.sh/<topic> or self-hosted).
async function notify(url, text) {
  const host = new URL(url).hostname;
  const title = "Remote Wake";
  const init =
    host === "api.day.app"
      ? { body: JSON.stringify({ title, body: text }), json: true }
      : host.endsWith("ftqq.com")
        ? { body: JSON.stringify({ title: text, desp: text }), json: true }
        : { body: text, headers: { Title: title } };
  await fetch(url, {
    method: "POST",
    headers: {
      ...(init.json ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body,
    signal: AbortSignal.timeout(10000),
  });
}
