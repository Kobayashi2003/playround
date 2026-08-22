// Renderer: builds the server x tool toggle matrix and wires the panels.
// All privileged work goes through window.api (see preload.cjs).

const $ = (id) => document.getElementById(id);
const msgBar = $("msg");
let msgTimer;

/** Show a message. Errors persist; info messages clear themselves after a moment. */
function notify(text, isError = false) {
  clearTimeout(msgTimer);
  msgBar.textContent = text ? (isError ? `Error: ${text}` : text) : "";
  msgBar.className = text ? (isError ? "err" : "ok") : "";
  if (text && !isError) msgTimer = setTimeout(() => notify(""), 2500);
}

/** Await an api call and surface failures. Returns the full { ok, data } result
 *  so callers branch on `ok` — a successful void call is still a success. */
async function call(promise) {
  notify("");
  const res = await promise;
  if (!res.ok) notify(res.error, true);
  return res;
}

function defSummary(def) {
  return [def.command, ...(def.args || [])].join(" ");
}

function renderMatrix(state) {
  const { tools, servers, status } = state;
  const stateOf = (name, tool) => status.find((r) => r.name === name)?.state[tool] ?? "off";

  if (servers.length === 0) {
    $("matrix").innerHTML = '<div class="empty">No servers yet. Import or add one below.</div>';
    return;
  }

  const head = tools.map((t) => `<th class="tool">${t}</th>`).join("");
  const rows = servers
    .map((s) => {
      const cells = tools
        .map((t) => {
          const st = stateOf(s.name, t);
          const attrs = st === "err" ? "disabled title='config unreadable'" : "";
          const checked = st === "on" ? "checked" : "";
          return `<td class="tool"><input type="checkbox" data-name="${s.name}" data-tool="${t}" ${checked} ${attrs} /></td>`;
        })
        .join("");
      return `<tr>
        <td><div class="name">${s.name}</div><div class="def">${defSummary(s.definition)}</div></td>
        ${cells}
        <td class="tool"><button class="link" data-remove="${s.name}">remove</button></td>
      </tr>`;
    })
    .join("");

  $("matrix").innerHTML = `<table>
    <thead><tr><th>server</th>${head}<th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;

  $("matrix").querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.addEventListener("change", async () => {
      const { name, tool } = box.dataset;
      const res = await call(window.api.toggle(name, tool, box.checked));
      if (!res.ok) {
        box.checked = !box.checked; // revert on failure
        return;
      }
      notify(`${box.checked ? "Enabled" : "Disabled"} ${name} in ${tool} — restart ${tool} to apply`);
    });
  });
  $("matrix").querySelectorAll("button[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.remove;
      if (!confirm(`Remove "${name}" from the registry and all tools?`)) return;
      if ((await call(window.api.remove(name))).ok) {
        notify(`Removed ${name}`);
        load();
      }
    });
  });
}

async function load() {
  const res = await call(window.api.load());
  if (!res.ok) return;
  const state = res.data;
  const sel = $("importTool");
  if (sel.options.length === 0) {
    sel.innerHTML = state.tools.map((t) => `<option>${t}</option>`).join("");
  }
  renderMatrix(state);
}

function parseWords(value) {
  return value.trim() ? value.trim().split(/\s+/) : [];
}

$("refresh").addEventListener("click", load);

$("importBtn").addEventListener("click", async () => {
  const tool = $("importTool").value;
  const res = await call(window.api.importTool(tool));
  if (!res.ok) return;
  const { imported, skipped } = res.data;
  notify(`Imported ${imported.length} from ${tool}` + (skipped.length ? `, skipped ${skipped.length}` : ""));
  load();
});

$("addBtn").addEventListener("click", async () => {
  const name = $("addName").value.trim();
  const command = $("addCommand").value.trim();
  if (!name || !command) return notify("name and command are required", true);
  const env = {};
  for (const pair of parseWords($("addEnv").value)) {
    const i = pair.indexOf("=");
    if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
  }
  const def = { command, args: parseWords($("addArgs").value), env };
  if (!(await call(window.api.add(name, def))).ok) return;
  $("addName").value = $("addCommand").value = $("addArgs").value = $("addEnv").value = "";
  notify(`Added ${name} — tick a column to enable it`);
  load();
});

load();
