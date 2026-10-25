const $ = (id) => document.getElementById(id);
const messages = {
  incorrect_password: "Incorrect password.",
  password_required: "Enter your password.",
  password_not_set:
    "No password is configured. Set ACCESS_PASSWORD on the server.",
  device_offline: "Wake board offline. Check its power and Wi-Fi.",
  pc_offline: "The PC is asleep, off, or its agent is not running.",
  unknown_action: "The PC no longer offers that action. Refresh the page.",
  command_pending: "A request is already pending.",
  cooldown: "Wait a few seconds before trying again.",
  invalid_schedule: "That schedule is not valid.",
  too_many_attempts: "Too many attempts. Try again in a minute.",
  service_unavailable: "Service unavailable. Try again.",
};
// How long a confirm-first action stays armed after the first tap.
const CONFIRM_MS = 4000;
const EVENTS_COLLAPSED = 6;
// Monday first, as weeks are read; values are JavaScript weekdays.
const DAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
];
const LED_LEVELS = [
  ["off", "Off"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
];
const PANELS = ["controlPanel", "eventsPanel", "schedulePanel", "boardPanel"];
let timer;
let refreshing = false;
let busy = false;
let armed = null;
let disarmTimer;
let showAllEvents = false;
let ledError = "";
let latest;

class ApiError extends Error {
  constructor(code, status) {
    super(messages[code] || "Request failed. Try again.");
    this.status = status;
  }
}
async function api(path, body) {
  const response = await fetch(new URL(path, document.baseURI), {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  // Cloudflare error pages are HTML, so a failed parse means a failed request.
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error, response.status);
  return data;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function formatTime(ms) {
  return new Date(ms).toLocaleString("en-GB", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} d ${hours} h`;
  if (hours) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}
function describeDays(days) {
  const key = [...days].sort().join("");
  if (key === "12345") return "Weekdays";
  if (key === "06") return "Weekends";
  if (days.length === 7) return "Every day";
  return DAYS.filter(([value]) => days.includes(value))
    .map(([, name]) => name)
    .join(", ");
}
function setLocked(locked) {
  if (locked) clearTimeout(timer);
  // The wide two-column layout only applies once unlocked.
  $("controller").dataset.locked = String(locked);
  $("loginPanel").hidden = !locked;
  for (const id of PANELS) $(id).hidden = locked;
  $("logoutButton").hidden = locked;
  if (locked) $("loginPassword").focus();
}
function describe(command) {
  if (!command) return "No requests yet";
  if (command.kind !== "action") {
    return (
      {
        pending: "Pending",
        sent: "Wake packets sent",
        failed: "Send failed",
        expired: "Request expired",
      }[command.status] || "Unknown result"
    );
  }
  const prefix = {
    pending: "Waiting for PC",
    sent: "Sent to PC",
    failed: "PC could not run",
    unreachable: "PC did not respond",
    expired: "Request expired",
  }[command.status];
  return `${prefix || "Unknown result"}: ${command.label}`;
}
function renderPc(state, pending) {
  const { power, agent, actions } = state.pc;
  const label = {
    on: agent ? "On" : "On, agent not running",
    sleep: "Asleep",
    off: "Off",
  }[power];
  $("pcState").dataset.state = power ?? "unknown";
  $("pcState").textContent = label ?? "Unknown";
  $("pcHint").hidden = actions.length > 0 && agent;
  $("pcHint").textContent = actions.length
    ? "These need the PC on with you signed in."
    : "Run install_agent.ps1 on the PC to add shut down, restart and your own actions here.";
  $("pcActions").replaceChildren(
    ...actions.map((action) => {
      const button = element("button", "action-button", action.label);
      button.type = "button";
      button.disabled = !agent || pending || Boolean(busy);
      const isArmed = armed === action.id && !button.disabled;
      button.dataset.armed = String(isArmed);
      if (isArmed) button.append(element("small", "", "Tap again"));
      button.addEventListener("click", () => runAction(action));
      return button;
    }),
  );
}
function renderWake(state, pending) {
  const wakePending = pending && state.command.kind !== "action";
  const pcOn = state.pc.power === "on" || state.pc.agent;
  const waking = Boolean(state.wake) && !pcOn;
  const wake = $("wakeButton");
  wake.disabled = !state.online || pending || Boolean(busy) || pcOn || waking;
  wake.dataset.pending = String(wakePending || busy === "wake" || waking);
  wake.dataset.awake = String(pcOn && !wakePending);
  const elapsed = waking
    ? Math.max(0, Math.round((state.serverTime - state.wake.sentAt) / 1000))
    : 0;
  $("buttonLabel").textContent =
    busy === "wake"
      ? "Sending"
      : wakePending
        ? "Pending"
        : waking
          ? `Waking up, ${elapsed} s`
          : pcOn
            ? "PC is on"
            : "Wake PC";
}
function renderEvents(events) {
  const shown = showAllEvents ? events : events.slice(0, EVENTS_COLLAPSED);
  $("eventsEmpty").hidden = events.length > 0;
  $("moreEvents").hidden = events.length <= EVENTS_COLLAPSED;
  $("moreEvents").textContent = showAllEvents ? "Show fewer" : "Show all";
  $("events").replaceChildren(
    ...shown.map((event) => {
      const item = element("li", "event");
      item.dataset.level = event.level;
      const time = element("time", "", formatTime(event.at));
      time.dateTime = new Date(event.at).toISOString();
      item.append(time, element("span", "", event.text));
      return item;
    }),
  );
}
function renderSchedules(state) {
  $("schedules").replaceChildren(
    ...state.schedules.map((schedule) => {
      const item = element("li", "schedule");
      const text = element("span", "schedule-text");
      text.append(
        element("strong", "", schedule.time),
        element("span", "", describeDays(schedule.days)),
      );
      const toggle = element("input");
      toggle.type = "checkbox";
      toggle.setAttribute("role", "switch");
      toggle.checked = schedule.enabled;
      toggle.setAttribute("aria-label", `Enable ${schedule.time}`);
      toggle.addEventListener("change", () =>
        saveSchedules(
          latest.schedules.map((item) =>
            item.id === schedule.id
              ? { ...item, enabled: toggle.checked }
              : item,
          ),
        ),
      );
      const remove = element("button", "text-button", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${schedule.time}`);
      remove.addEventListener("click", () =>
        saveSchedules(
          latest.schedules.filter((item) => item.id !== schedule.id),
        ),
      );
      item.append(text, toggle, remove);
      return item;
    }),
  );
  $("nextWake").textContent = state.nextWake
    ? `Next ${formatTime(state.nextWake)}`
    : "";
  $("timeZone").textContent =
    `Times are in ${state.timeZone}. A scheduled wake is skipped when the PC is already on.`;
}
function renderBoard(state) {
  const board = state.board;
  const offered = state.firmware?.digest;
  $("boardTemperature").textContent =
    board?.temperature !== undefined
      ? `${board.temperature.toFixed(1)} °C`
      : "—";
  $("boardSignal").textContent =
    board?.rssi !== undefined
      ? `${board.rssi} dBm, ${board.rssi >= -60 ? "strong" : board.rssi >= -70 ? "good" : "weak"}`
      : "—";
  $("boardUptime").textContent =
    board?.uptime !== undefined ? formatDuration(board.uptime) : "—";
  const pending = offered && board?.firmware && offered !== board.firmware;
  $("boardFirmware").textContent = board?.firmware
    ? `${board.build ?? board.firmware.slice(0, 8)}${pending ? ", update pending" : ""}`
    : "—";
  $("boardFirmware").title = board?.firmware ?? "";
  const chosen = state.settings.led;
  const shown = chosen ?? board?.led;
  for (const input of $("ledPicker").querySelectorAll("input")) {
    input.checked = input.value === shown;
    input.disabled = busy === "led";
  }
  // The board echoes the level it applied; older firmware echoes nothing.
  const hint = ledError
    ? ledError
    : !chosen
      ? ""
      : !board
        ? "Applies when the wake board is back online."
        : board.led === undefined
          ? "Needs a firmware update on the wake board."
          : board.led !== chosen
            ? "Applying…"
            : "";
  $("ledHint").hidden = !hint;
  $("ledHint").textContent = hint;
}
function render(state) {
  latest = state;
  $("connection").dataset.state = state.online ? "online" : "offline";
  $("connectionText").textContent = state.online
    ? "Wake board online"
    : "Wake board offline";
  const pending = state.command?.status === "pending";
  $("controlPanel").dataset.state = state.online ? "online" : "offline";
  $("commandResult").dataset.status = state.command?.status ?? "none";
  renderWake(state, pending);
  renderPc(state, pending);
  $("commandResult").textContent = describe(state.command);
  $("commandTime").textContent = state.command
    ? formatTime(state.command.issuedAt)
    : "—";
  renderEvents(state.events);
  renderSchedules(state);
  renderBoard(state);
  setLocked(false);
}
async function refresh() {
  if (refreshing || document.hidden) return;
  refreshing = true;
  try {
    const state = await api("./api/status");
    if ($("loginPanel").hidden) render(state);
  } catch (error) {
    if (error.status === 401) {
      setLocked(true);
      return;
    }
    $("connection").dataset.state = "offline";
    $("controlPanel").dataset.state = "connecting";
    $("connectionText").textContent = "Reconnecting";
    $("wakeButton").disabled = true;
  } finally {
    refreshing = false;
    clearTimeout(timer);
    // Faster while a wake is being tracked, so the counter keeps moving.
    if ($("loginPanel").hidden)
      timer = setTimeout(refresh, latest?.wake ? 2000 : 5000);
  }
}
async function send(kind, path, body) {
  busy = kind;
  armed = null;
  if (latest) render(latest);
  $("actionError").textContent = "";
  try {
    await api(path, body);
  } catch (error) {
    $("actionError").textContent = error.message;
  } finally {
    busy = false;
    await refresh();
  }
}
function runAction(action) {
  if (action.confirm && armed !== action.id) {
    armed = action.id;
    clearTimeout(disarmTimer);
    disarmTimer = setTimeout(() => {
      armed = null;
      if (latest) render(latest);
    }, CONFIRM_MS);
    if (latest) render(latest);
    return;
  }
  clearTimeout(disarmTimer);
  send("action", "./api/action", { action: action.id });
}
async function saveSchedules(schedules) {
  $("scheduleError").textContent = "";
  try {
    await api("./api/schedules", { schedules });
  } catch (error) {
    $("scheduleError").textContent = error.message;
  }
  await refresh();
}
async function setLed(level) {
  busy = "led";
  ledError = "";
  if (latest) renderBoard(latest);
  try {
    await api("./api/board", { led: level });
  } catch (error) {
    ledError = error.message;
  } finally {
    busy = false;
    await refresh();
  }
}
function chip(type, name, value, text) {
  const label = element("label", "chip");
  const input = element("input");
  input.type = type;
  input.name = name;
  input.value = value;
  label.append(input, element("span", "", text));
  return label;
}
for (const [value, name] of DAYS) {
  const label = chip("checkbox", "day", String(value), name);
  label.querySelector("input").checked = value >= 1 && value <= 5;
  $("scheduleDays").append(label);
}
for (const [value, name] of LED_LEVELS) {
  const label = chip("radio", "led", value, name);
  label.querySelector("input").addEventListener("change", () => setLed(value));
  $("ledPicker").append(label);
}
$("scheduleForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const days = [...$("scheduleDays").querySelectorAll("input:checked")].map(
    (input) => Number(input.value),
  );
  if (!days.length) {
    $("scheduleError").textContent = "Pick at least one day.";
    return;
  }
  saveSchedules([
    ...(latest?.schedules ?? []),
    { time: $("scheduleTime").value, days, enabled: true },
  ]);
});
$("moreEvents").addEventListener("click", () => {
  showAllEvents = !showAllEvents;
  if (latest) renderEvents(latest.events);
});
$("wakeButton").addEventListener("click", () => send("wake", "./api/wake", {}));
$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("loginError").textContent = "";
  try {
    await api("./api/login", { password: $("loginPassword").value });
    $("loginPassword").value = "";
    setLocked(false);
    await refresh();
  } catch (error) {
    $("loginError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("logoutButton").addEventListener("click", async () => {
  try {
    await api("./api/logout", {});
    setLocked(true);
  } catch (error) {
    $("actionError").textContent = error.message;
  }
});
document.addEventListener("visibilitychange", () => {
  clearTimeout(timer);
  if (!document.hidden && $("loginPanel").hidden) refresh();
});
refresh();
