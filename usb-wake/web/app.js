const $ = (id) => document.getElementById(id);
const messages = {
  incorrect_password: "Incorrect password.",
  password_required: "Enter your password.",
  password_not_set:
    "No password is set yet. Set one in Settings with the management key.",
  invalid_management_key: "Invalid management key.",
  password_length: "Use at least 8 characters (up to 256 bytes).",
  device_offline: "Device offline. Check power and Wi-Fi.",
  command_pending: "A request is already pending.",
  wake_cooldown: "Wait a few seconds before trying again.",
  too_many_attempts: "Too many attempts. Try again in a minute.",
  service_unavailable: "Service unavailable. Try again.",
};
let passwordRequired = false;
let timer;
let refreshing = false;
let busy = false;
let latest;

class ApiError extends Error {
  constructor(code, status) {
    super(messages[code] || "Request failed. Try again.");
    this.status = status;
  }
}
async function api(path, body, managementKey) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (managementKey) headers.Authorization = `Bearer ${managementKey}`;
  const response = await fetch(new URL(path, document.baseURI), {
    method: body === undefined ? "GET" : "POST",
    headers,
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
function setLocked(locked) {
  if (locked) clearTimeout(timer);
  $("loginPanel").hidden = !locked;
  $("controlPanel").hidden = locked;
  $("sessionControls").hidden = locked || !passwordRequired;
}
function render(state) {
  latest = state;
  $("connection").dataset.state = state.online ? "online" : "offline";
  $("connectionText").textContent = state.online
    ? "Device online"
    : "Device offline";
  const pending = state.command?.status === "pending";
  $("wakeButton").disabled = !state.online || pending || busy;
  $("wakeButton").dataset.pending = String(pending || busy);
  $("buttonLabel").textContent = busy
    ? "Sending"
    : pending
      ? "Pending"
      : "Wake PC";
  const labels = {
    pending: "Pending",
    sent: "Wake packets sent",
    failed: "Send failed",
    expired: "Request expired",
  };
  $("commandResult").textContent =
    labels[state.command?.status] || "No requests yet";
  $("commandTime").textContent = state.command
    ? new Date(state.command.issuedAt).toLocaleString("en-GB", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
  passwordRequired = state.passwordRequired;
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
      passwordRequired = true;
      setLocked(true);
      return;
    }
    $("connection").dataset.state = "offline";
    $("connectionText").textContent = "Reconnecting";
    $("wakeButton").disabled = true;
  } finally {
    refreshing = false;
    clearTimeout(timer);
    if ($("loginPanel").hidden) timer = setTimeout(refresh, 5000);
  }
}
$("wakeButton").addEventListener("click", async () => {
  busy = true;
  if (latest) render(latest);
  $("actionError").textContent = "";
  try {
    await api("./api/wake", {});
  } catch (error) {
    $("actionError").textContent = error.message;
  } finally {
    busy = false;
    await refresh();
  }
});
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
$("settingsButton").addEventListener("click", () => {
  $("passwordEnabled").checked = passwordRequired;
  togglePassword();
  $("settingsMessage").textContent = "";
  $("settingsDialog").showModal();
});
function togglePassword() {
  const enabled = $("passwordEnabled").checked;
  $("newPasswordField").hidden = !enabled;
  $("newPassword").disabled = !enabled;
  $("newPassword").required = enabled;
}
$("passwordEnabled").addEventListener("change", togglePassword);
$("closeSettings").addEventListener("click", () => $("settingsDialog").close());
$("settingsDialog").addEventListener("close", () => {
  $("managementKey").value = "";
  $("newPassword").value = "";
});
$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("saveSettings").disabled = true;
  $("settingsMessage").textContent = "";
  try {
    const enabled = $("passwordEnabled").checked;
    const result = await api(
      "./api/settings",
      {
        enabled,
        ...(enabled ? { password: $("newPassword").value } : {}),
      },
      $("managementKey").value.trim(),
    );
    passwordRequired = result.passwordRequired;
    $("settingsDialog").close();
    $("loginError").textContent = "";
    setLocked(false);
    await refresh();
  } catch (error) {
    $("settingsMessage").textContent = error.message;
  } finally {
    $("saveSettings").disabled = false;
  }
});
document.addEventListener("visibilitychange", () => {
  clearTimeout(timer);
  if (!document.hidden && $("loginPanel").hidden) refresh();
});
refresh();
