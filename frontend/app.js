/* OpenCNC Web - logika tabletového rozhraní (bez frameworku). */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 3) => (v >= 0 ? " " : "") + Number(v).toFixed(d);
const clone = (o) => JSON.parse(JSON.stringify(o));

const S = {
  auth: null, st: null, m: null, screen: "run", lastMsg: 0, messages: [], failCount: 0,
  inc: 0, jog: null, jogTimer: null, history: [],
  loadedPath: null, gcodeLines: [], runStart: null,
  setup: null, draft: null, saved: null, step: 0, setupTab: "wizard", validation: null,
  diag: null, diagTab: "overview", diagTimer: null, motor: { joint: 0, timer: null, dir: 0 },
  files: [], selFile: null, tools: null, ovrDrag: {},
};

/* ================================================================ komunikace */

async function http(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    if (raw) opt.body = body;
    else { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  }
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({ ok: false, error: "Server vrátil chybu " + r.status }));
  if (!j.ok) {
    if (j.needs_setup) showFirstRun();
    else if (j.login) openLogin(j.login);
    const e = new Error(j.error || "Chyba"); e.data = j; throw e;
  }
  return j;
}
const get = (u) => http("GET", u);
const post = (u, b, raw) => http("POST", u, b, raw);
async function api(cmd, args = {}) {
  try { await post("/api/cmd", { cmd, ...args }); return true; }
  catch (e) { toast(e.message); return false; }
}

function toast(text, kind) {
  const t = $("#toast");
  t.textContent = text; t.className = "toast" + (kind === "info" ? " info" : ""); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4500);
}

/* ================================================================ přihlášení */

function isAdmin() { return S.auth && S.auth.role === "admin"; }

async function refreshAuth() {
  S.auth = await get("/api/auth");
  const b = $("#bUser");
  b.textContent = S.auth.role === "admin" ? "Správce" : S.auth.role === "operator" ? "Obsluha" : "Přihlásit";
  if (S.auth.needs_setup) showFirstRun();
  else if (!S.auth.role) openLogin("operator");
  if (S.screen === "setup") showSetup();
}

function showFirstRun() { $("#firstModal").hidden = false; $("#firstAdmin").focus(); }
let loginRole = "operator";
function openLogin(role) {
  if (!$("#firstModal").hidden) return;
  loginRole = role || "operator";
  $$("#loginRole button").forEach((b) => b.classList.toggle("on", b.dataset.role === loginRole));
  $("#logout").hidden = !S.auth || !S.auth.role;
  $("#loginCancel").hidden = !S.auth || !S.auth.role;
  $("#loginModal").hidden = false;
  $("#loginPw").value = ""; $("#loginPw").focus();
}
$$("#loginRole button").forEach((b) => b.addEventListener("click", () => {
  loginRole = b.dataset.role;
  $$("#loginRole button").forEach((x) => x.classList.toggle("on", x === b));
}));
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await post("/api/auth/login", { role: loginRole, password: $("#loginPw").value }); $("#loginModal").hidden = true; await refreshAuth(); }
  catch (err) { toast(err.message); }
});
$("#loginCancel").addEventListener("click", () => ($("#loginModal").hidden = true));
$("#logout").addEventListener("click", async () => { await post("/api/auth/logout", {}).catch(() => {}); $("#loginModal").hidden = true; await refreshAuth(); });
$("#bUser").addEventListener("click", () => openLogin(S.auth && S.auth.role === "operator" ? "admin" : "operator"));
$("#firstForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await post("/api/auth/setup", { admin: $("#firstAdmin").value, operator: $("#firstOperator").value });
    $("#firstModal").hidden = true; await refreshAuth(); showScreen("setup");
  } catch (err) { toast(err.message); }
});
document.addEventListener("click", (e) => { const b = e.target.closest("[data-login]"); if (b) openLogin(b.dataset.login); });

/* ================================================================ navigace */

const SCREENS = ["setup", "run", "jog", "tools", "diag", "files"];
function showScreen(name) {
  if (!SCREENS.includes(name)) name = "run";
  if (S.screen === "jog" && name !== "jog") stopJog();
  S.screen = name;
  SCREENS.forEach((s) => ($("#s-" + s).hidden = s !== name));
  $$("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.s === name));
  history.replaceState(null, "", "#" + name);
  if (name === "setup") showSetup();
  if (name === "tools") loadTools();
  if (name === "files") loadFiles();
  if (name === "run" && tpRun) tpRun.redraw();
  manageDiagPolling();
  if (S.st) render();
}
$$("#nav button").forEach((b) => b.addEventListener("click", () => showScreen(b.dataset.s)));
document.addEventListener("keydown", (e) => {
  const m = /^F([1-6])$/.exec(e.key);
  if (m) { e.preventDefault(); showScreen(SCREENS[+m[1] - 1]); }
});

/* ================================================================ stav */

async function poll() {
  try {
    const r = await fetch("/api/status?since=" + S.lastMsg, { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) {
      if (j.needs_setup) showFirstRun(); else if (j.login) openLogin(j.login);
    } else {
      S.st = j; S.m = j.machine; S.failCount = 0; $("#offline").hidden = true;
      if (j.messages.length) {
        S.messages.push(...j.messages); S.messages = S.messages.slice(-80);
        const fresh = j.messages.filter((x) => x.kind !== "info");
        if (S.lastMsg && fresh.length) toast(fresh[fresh.length - 1].text);
        S.lastMsg = j.last_msg;
      } else if (!S.lastMsg) S.lastMsg = j.last_msg;
      render();
    }
  } catch (e) {
    if (++S.failCount >= 4) { $("#offline").hidden = false; stopJog(false); }
  } finally {
    setTimeout(poll, document.hidden ? 1500 : 200);
  }
}

function pill(el, cls, text) { el.className = "pill " + cls; el.textContent = text; }
const RT = { stopped: ["", "Řízení stojí"], starting: ["warn", "Startuje"], running: ["ok", "Řízení běží"],
             stopping: ["warn", "Zastavuje"], failed: ["bad", "Chyba řízení"] };

function render() {
  const st = S.st, m = S.m, rt = st.runtime;
  pill($("#pRuntime"), ...(RT[rt.state] || ["", rt.state]));
  if (m) pill($("#pMachine"), { estop: "bad", off: "warn", on: "ok" }[m.state] || "",
              { estop: "E-stop", off: "Vypnuto", on: "Zapnuto" }[m.state] + (m.interp === "running" ? " · běží" : m.interp === "paused" ? " · pauza" : ""));
  else pill($("#pMachine"), "", "Stroj –");
  pill($("#pBoard"), st.board.ok ? "ok" : "bad", st.board.ok ? "EC300" : "EC300 offline");
  const al = $("#alarms");
  al.hidden = !st.alarms.length;
  al.innerHTML = st.alarms.map((a) => "<b>⚠</b> " + esc(a)).join(" &nbsp;·&nbsp; ");

  if (S.screen === "run") renderRun();
  if (S.screen === "jog") renderJog();
  if (S.screen === "tools") $("#toolCur").textContent = "T" + (m ? m.tool : "–");
  if (S.screen === "diag") renderDiagOverview();
}

/* ---------- DRO (sdílené pro Běh a Jog) ---------- */
function renderDro(el, withActions) {
  const m = S.m;
  if (!m) { el.innerHTML = '<div class="empty">Řízení neběží. Spusť ho v F5 Diagnostika.</div>'; el.dataset.n = ""; return; }
  const key = m.dro.map((a) => a.axis).join("") + (withActions ? "a" : "");
  if (el.dataset.n !== key) {
    el.dataset.n = key;
    el.innerHTML = m.dro.map((a) => `<div class="ax"><div class="l">${a.axis}</div>
      <div><div class="w mono"></div><div class="m mono"></div></div>
      <div class="acts">${withActions ? `<button class="btn sm" data-zero="${a.index}">0</button><button class="btn sm" data-home="${a.index}">Ref</button>` : ""}</div></div>`).join("");
  }
  const on = m.state === "on", idle = m.interp === "idle", d = m.units === "mm" ? 3 : 4;
  m.dro.forEach((a, i) => {
    const row = el.children[i];
    $(".w", row).textContent = fmt(a.work, d);
    $(".m", row).textContent = "stroj " + fmt(a.machine, d) + (Math.abs(a.dtg) > 1e-4 ? "  zbývá " + fmt(a.dtg, d) : "");
    $(".l", row).classList.toggle("homed", !!m.homed[i]);
    $$("button", row).forEach((b) => (b.disabled = !on || !idle || (b.dataset.zero !== undefined && !m.all_homed)));
  });
}
document.addEventListener("click", (e) => {
  const z = e.target.closest("[data-zero]"), h = e.target.closest("[data-home]");
  if (z) api("touchoff", { axis: +z.dataset.zero, value: 0 });
  if (h) api("home", { axis: +h.dataset.home });
});
const WCS = ["G54", "G55", "G56", "G57", "G58", "G59"];

/* ================================================================ F2 Běh */

let tpRun = null;
function renderRun() {
  const m = S.m;
  renderDro($("#runDro"), false);
  if (!tpRun) tpRun = Toolpath.create($("#runTp"), $("#runTpInfo"));
  const on = m && m.state === "on", idle = m && m.interp === "idle";
  $("#bRun").disabled = !on || !idle || !m.file || !m.all_homed;
  const paused = m && m.interp === "paused";
  $("#bPause").textContent = paused ? "Pokračovat" : "Pauza";
  $("#bPause").disabled = !m || (m.interp !== "running" && !paused);
  $("#bStep").disabled = !on || !m.file || m.interp === "running";
  $("#bStop").disabled = !m;
  if (!m) { $("#runFile").textContent = "řízení neběží"; return; }
  $("#runWcs").textContent = WCS[m.g5x_index - 1] || "G5x";
  $("#runTool").textContent = "T" + m.tool;
  $("#runSpindle").textContent = "S " + Math.round(Math.abs(m.spindle.speed)) + (m.spindle.enabled ? (m.spindle.direction < 0 ? " ↺" : " ↻") : " stojí");
  $("#runFile").textContent = m.file || "žádný";
  if (m.file_path !== S.loadedPath) loadRunFile();
  const line = m.interp === "idle" ? 0 : (m.motion_line || m.current_line);
  const total = S.gcodeLines.length;
  $("#runProg").style.width = total ? Math.min(100, (100 * line) / total) + "%" : "0";
  $("#runLine").textContent = total ? (line ? "řádek " + line + " / " + total : total + " řádků") : "";
  if (m.interp !== "idle" && !S.runStart) S.runStart = Date.now();
  if (m.interp === "idle") S.runStart = null;
  $("#runTime").textContent = S.runStart ? "čas " + new Date(Date.now() - S.runStart).toISOString().substr(11, 8) : "";
  tpRun.setLine(line);
  const p = { X: 0, Y: 0, Z: 0 };
  m.dro.forEach((a) => (p[a.axis] = a.work));
  tpRun.setTool([p.X, p.Y, p.Z]);
  highlightGcode(line);
  syncSlider("oFeed", m.feed_override, m.max_feed_override);
  syncSlider("oRapid", m.rapid_override, 1);
  syncSlider("oSpindle", m.spindle.override, m.max_spindle_override);
}

async function loadRunFile() {
  S.loadedPath = S.m.file_path;
  S.gcodeLines = []; lastHl = -1;
  const box = $("#runGcode");
  if (!S.loadedPath) { box.innerHTML = '<div class="empty" style="padding:6px 10px">Program načteš v F6 Soubory.</div>'; tpRun.clear(); return; }
  try {
    const j = await get("/api/file");
    S.gcodeLines = j.text.split("\n");
    const shown = S.gcodeLines.slice(0, 20000);
    box.innerHTML = shown.map((l, i) => `<div><span class="ln">${i + 1}</span>${esc(l)}</div>`).join("");
    tpRun.load(j.text);
  } catch (e) { toast(e.message); }
}
let lastHl = -1;
function highlightGcode(n) {
  if (n === lastHl) return;
  const box = $("#runGcode");
  if (lastHl > 0 && box.children[lastHl - 1]) box.children[lastHl - 1].classList.remove("cur");
  lastHl = n;
  const row = n > 0 ? box.children[n - 1] : null;
  if (row) { row.classList.add("cur"); row.scrollIntoView({ block: "center" }); }
}
function syncSlider(id, value, max) {
  const el = $("#" + id);
  el.max = Math.round(max * 100);
  if (!S.ovrDrag[id]) el.value = Math.round(value * 100);
  $("#" + id + "Out").textContent = el.value + " %";
}
[["oFeed", "feed_override"], ["oRapid", "rapid_override"], ["oSpindle", "spindle_override"]].forEach(([id, cmd]) => {
  const el = $("#" + id);
  el.addEventListener("input", () => { S.ovrDrag[id] = true; $("#" + id + "Out").textContent = el.value + " %"; });
  el.addEventListener("change", () => { api(cmd, { value: el.value / 100 }); setTimeout(() => (S.ovrDrag[id] = false), 500); });
});
$("#bRun").addEventListener("click", () => api("run"));
$("#bPause").addEventListener("click", () => api(S.m && S.m.interp === "paused" ? "resume" : "pause"));
$("#bStep").addEventListener("click", () => api("step"));
$("#bStop").addEventListener("click", () => api("stop"));
$$("#runTp [data-view]").forEach((b) => b.addEventListener("click", () => tpRun && tpRun.view(b.dataset.view)));

/* ================================================================ F3 Jog */

function renderJog() {
  const m = S.m;
  renderDro($("#jogDro"), true);
  const on = m && m.state === "on", idle = m && m.interp === "idle";
  const bp = $("#bPower");
  if (!m) { bp.textContent = "Zapnout"; bp.disabled = true; }
  else if (m.state === "estop") { bp.textContent = "Reset E-stop"; bp.className = "btn"; bp.disabled = false; }
  else { bp.textContent = on ? "Vypnout" : "Zapnout"; bp.className = "btn " + (on ? "" : "good"); bp.disabled = false; }
  $("#bHomeAll").disabled = !on || !idle;
  $$(".pad .jog").forEach((b) => (b.disabled = !on || !idle));
  const seg = $("#wcsSeg");
  if (!seg.children.length) seg.innerHTML = WCS.map((w, i) => `<button data-wcs="${i + 1}">${w}</button>`).join("");
  $$("button", seg).forEach((b) => { b.classList.toggle("on", m && +b.dataset.wcs === m.g5x_index); b.disabled = !on || !idle || !m.all_homed; });
  if (m) {
    $("#jogWcs").textContent = WCS[m.g5x_index - 1] || "";
    $("#jogMode").textContent = m.all_homed ? "osy" : "motory (před referováním)";
    const v = (+$("#jogSpeed").value / 100) * m.max_jog_velocity;
    $("#jogSpeedOut").textContent = Math.round(v * 60) + " mm/min";
  }
  $("#jogHint").textContent = S.inc ? "klepnutí = " + S.inc + " mm" : "držet = jet";
}
$("#wcsSeg").addEventListener("click", (e) => { const b = e.target.closest("[data-wcs]"); if (b) api("select_wcs", { index: +b.dataset.wcs }); });
$("#bHomeAll").addEventListener("click", () => api("home_all"));
$("#bPower").addEventListener("click", () => {
  const m = S.m; if (!m) return;
  api(m.state === "estop" ? "estop_reset" : m.state === "on" ? "machine_off" : "machine_on");
});
$$("#incSeg button").forEach((b) => b.addEventListener("click", () => {
  $$("#incSeg button").forEach((x) => x.classList.toggle("on", x === b)); S.inc = +b.dataset.inc; render();
}));
$("#jogSpeed").addEventListener("input", () => S.st && render());

function startJog(btn) {
  if (btn.disabled || !S.m) return;
  const axis = +btn.dataset.axis, dir = +btn.dataset.dir;
  const velocity = (+$("#jogSpeed").value / 100) * S.m.max_jog_velocity;
  if (S.inc) { api("jog_start", { axis, dir, velocity, increment: S.inc }); btn.classList.add("active"); setTimeout(() => btn.classList.remove("active"), 150); return; }
  stopJog(false);
  S.jog = btn; btn.classList.add("active");
  api("jog_start", { axis, dir, velocity, increment: 0 });
  S.jogTimer = setInterval(() => post("/api/cmd", { cmd: "jog_keep" }).catch(() => {}), 150);
}
function stopJog(send = true) {
  if (S.jogTimer) { clearInterval(S.jogTimer); S.jogTimer = null; }
  if (S.jog) { S.jog.classList.remove("active"); S.jog = null; if (send) api("jog_stop"); }
}
$$(".pad .jog").forEach((b) => {
  b.addEventListener("pointerdown", (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); startJog(b); });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => b.addEventListener(ev, () => { if (S.jog === b) stopJog(); }));
  b.addEventListener("contextmenu", (e) => e.preventDefault());
});
window.addEventListener("blur", () => { stopJog(); stopMotor(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) { stopJog(); stopMotor(); } });

function sendMdi(text) {
  text = text.trim().toUpperCase();
  if (!text) return;
  api("mdi", { text }).then((ok) => {
    if (!ok) return;
    S.history = [text, ...S.history.filter((h) => h !== text)].slice(0, 30);
    $("#mdiHist").innerHTML = S.history.map((h) => `<button class="item mono">${esc(h)}</button>`).join("");
  });
}
$("#mdiForm").addEventListener("submit", (e) => { e.preventDefault(); sendMdi($("#mdiInput").value); $("#mdiInput").value = ""; });
$("#mdiHist").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) $("#mdiInput").value = b.textContent; });
$$("[data-mdi]").forEach((b) => b.addEventListener("click", () => sendMdi(b.dataset.mdi)));
$("#bEstop").addEventListener("pointerdown", () => { stopJog(false); stopMotor(); api("estop"); post("/api/diag/stop", {}).catch(() => {}); });

/* ================================================================ F4 Nástroje */

async function loadTools() {
  try { S.tools = (await get("/api/tools")).tools; renderTools(); } catch (e) { toast(e.message); }
}
function renderTools() {
  $("#toolBody").innerHTML = S.tools.map((t, i) => `<tr>
    <td><input class="inp num" style="width:70px" data-tool="${i}" data-k="t" type="number" min="1" value="${t.t}"></td>
    <td><input class="inp num" style="width:110px" data-tool="${i}" data-k="z" type="number" step="0.001" value="${t.z}"></td>
    <td><input class="inp num" style="width:100px" data-tool="${i}" data-k="d" type="number" step="0.001" value="${t.d}"></td>
    <td><input class="inp" data-tool="${i}" data-k="comment" value="${esc(t.comment)}"></td>
    <td><button class="btn xs danger" data-tooldel="${i}">✕</button></td></tr>`).join("") ||
    '<tr><td colspan="5" class="empty">Žádné nástroje.</td></tr>';
}
$("#toolBody").addEventListener("input", (e) => {
  const el = e.target.closest("[data-tool]"); if (!el) return;
  const t = S.tools[+el.dataset.tool], k = el.dataset.k;
  t[k] = k === "comment" ? el.value : parseFloat(el.value) || 0;
});
$("#toolBody").addEventListener("click", (e) => { const b = e.target.closest("[data-tooldel]"); if (b) { S.tools.splice(+b.dataset.tooldel, 1); renderTools(); } });
$("#toolAdd").addEventListener("click", () => { const n = Math.max(0, ...S.tools.map((t) => t.t)) + 1; S.tools.push({ t: n, p: n, z: 0, d: 6, comment: "" }); renderTools(); });
$("#toolSave").addEventListener("click", async () => { try { await post("/api/tools", { tools: S.tools }); toast("Tabulka nástrojů uložena.", "info"); loadTools(); } catch (e) { toast(e.message); } });
$("#toolChange").addEventListener("click", () => { const n = +$("#toolNum").value; if (n > 0) api("tool_change", { tool: n }); });

/* ================================================================ F5 Diagnostika */

function manageDiagPolling() {
  const need = S.screen === "diag" || (S.screen === "setup" && S.setupTab === "wizard" && S.step === 3);
  if (need && !S.diagTimer) { pollDiag(); S.diagTimer = setInterval(pollDiag, 400); }
  if (!need && S.diagTimer) { clearInterval(S.diagTimer); S.diagTimer = null; stopMotor(); }
}
async function pollDiag() {
  try {
    S.diag = await get("/api/diag");
    if (S.screen === "diag") renderDiag();
    if (S.screen === "setup") updateSetupLeds();
  } catch (e) { /* zobrazí poll stavu */ }
}
$$("#diagTabs button").forEach((b) => b.addEventListener("click", () => {
  S.diagTab = b.dataset.dt;
  $$("#diagTabs button").forEach((x) => x.classList.toggle("on", x === b));
  ["overview", "io", "motor", "system", "log"].forEach((t) => ($("#dt-" + t).hidden = t !== S.diagTab));
  if (S.diagTab === "motor") prepareMotor();
  renderDiag();
}));

function renderDiagOverview() {
  if (!S.st) return;
  const rt = S.st.runtime;
  pill($("#dRuntime"), ...(RT[rt.state] || ["", rt.state]));
  $("#dUptime").textContent = rt.state === "running" ? "běží " + Math.floor(rt.uptime / 60) + " min" : "";
  const stopped = rt.state === "stopped" || rt.state === "failed";
  $("#rtStart").disabled = !stopped || !rt.configured;
  $("#rtStop").disabled = stopped || !isAdmin();
  $("#rtRestart").disabled = stopped || !isAdmin();
  const note = $("#rtNote");
  note.hidden = !(rt.error || !rt.configured || rt.commissioning);
  note.className = "note " + (rt.error ? "bad" : "warn");
  note.textContent = rt.error || (!rt.configured ? "Stroj ještě není nastavený: projdi průvodce v F1 Nastavení."
    : "Nová konfigurace: před spuštěním správce potvrdí kontrolu bezpečnostních obvodů (tlačítko Spustit).");
  const b = S.st.board;
  $("#dBoard").innerHTML = `<dt>Spojení</dt><dd>${b.ok ? "OK" : "neodpovídá"}</dd>` +
    (b.rtt_ms != null ? `<dt>Odezva</dt><dd>${b.rtt_ms.toFixed(2)} ms</dd>` : "") +
    `<dt>Adresa</dt><dd>10.10.10.10 (UDP 27181)</dd><dt>Zdroj dat</dt><dd>${stopped ? "přímo z desky" : "přes LinuxCNC"}</dd>`;
  const list = S.messages.slice().reverse();
  $("#msgList").innerHTML = list.length ? list.map((x) => `<div class="msg ${x.kind}"><time>${new Date(x.t * 1000).toLocaleTimeString("cs-CZ")}</time>${esc(x.text)}</div>`).join("")
    : '<div class="empty">Žádné zprávy.</div>';
}

function renderDiag() {
  renderDiagOverview();
  const d = S.diag; if (!d) return;
  const stopped = d.runtime.state === "stopped" || d.runtime.state === "failed";
  if (S.diagTab === "io") {
    $("#ioSrc").textContent = stopped ? "čteno přímo z desky" : "čteno přes LinuxCNC";
    $("#ioIn").innerHTML = d.inputs.map((x) => `<div class="led ${x.on ? "on" : ""}"><i></i><div><b>${x.terminal}</b><br><span>${esc(x.function || "bit " + x.bit)}</span></div></div>`).join("");
    const canOut = stopped && isAdmin();
    $("#ioOut").innerHTML = d.outputs.map((x) => `<button class="led out ${x.on ? "on" : ""}" data-out="${x.bit}" ${canOut ? "" : "disabled"}><i></i><div><b>${x.terminal}</b><br><span>${esc(x.function || "nepřiřazeno")}</span></div></button>`).join("");
    $("#ioPwm").disabled = !canOut;
  }
  if (S.diagTab === "motor") {
    const c = (d.board.counts || [])[S.motor.joint] || 0;
    $("#motorCount").textContent = c;
    const sc = S.motor.scales ? S.motor.scales[S.motor.joint] : null;
    $("#motorDist").textContent = sc ? (c / sc).toFixed(3) + " mm" : "nastav osy v průvodci";
  }
  if (S.diagTab === "system") {
    const s = d.system || {};
    const rows = [["Model", s.model], ["Jádro", s.kernel], ["Real-time (PREEMPT_RT)", s.rt ? "ano" : "NE"], ["Teplota CPU", s.cpu_temp != null ? s.cpu_temp + " °C" : "–"],
      ["Zatížení", (s.load || []).map((x) => x.toFixed(2)).join(" ")], ["Paměť", s.mem_used_pct + " %"], ["Volné místo", s.disk_free_gb + " GB"],
      ["Doba běhu", s.uptime_h + " h"], ["LinuxCNC", s.linuxcnc], ["Komponenta Remora", s.remora_component ? "nainstalovaná" : "CHYBÍ"],
      ["pyOCD (flash)", s.pyocd ? "ano" : "ne"], ...(s.interfaces || []).map((i) => [i.name, i.addr])];
    $("#sysInfo").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v ?? "–")}</dd>`).join("");
    $("#jobLog").textContent = d.job ? d.job.title + "\n" + d.job.log.join("\n") : "–";
  }
  if (S.diagTab === "log") $("#rtLog").textContent = d.log || (isAdmin() ? "(prázdný)" : "Log vidí jen správce.");
}
$("#ioOut").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-out]"); if (!b) return;
  try { await post("/api/diag/output", { bit: +b.dataset.out, value: !b.classList.contains("on") }); pollDiag(); } catch (err) { toast(err.message); }
});
$("#ioPwm").addEventListener("input", () => ($("#ioPwmOut").textContent = $("#ioPwm").value + " %"));
$("#ioPwm").addEventListener("change", () => post("/api/diag/pwm", { percent: +$("#ioPwm").value }).catch((e) => toast(e.message)));
const SAFETY_CHECKS = [
  "Hardwarový E-stop odpojí napájení driverů (nebo STO) nezávisle na Raspberry Pi.",
  "Vstup E-stop a koncové spínače reagují v F5 → Vstupy / výstupy.",
  "Osy se v testu motoru pohybují správným směrem a o správnou vzdálenost.",
  "Vřeteno je odpojené nebo zajištěné a v pracovním prostoru nikdo není.",
];
$("#rtStart").addEventListener("click", () => {
  const rt = S.st && S.st.runtime;
  if (rt && rt.commissioning) {
    if (!isAdmin()) return openLogin("admin");
    if (!confirm("Nová konfigurace stroje. Potvrď, že jsi zkontroloval:\n\n• " + SAFETY_CHECKS.join("\n• "))) return;
    return post("/api/runtime", { action: "start", confirm_safety: true }).catch((e) => toast(e.message));
  }
  post("/api/runtime", { action: "start" }).catch((e) => toast(e.message));
});
$("#rtStop").addEventListener("click", () => { if (confirm("Zastavit řízení? Stroj se zastaví.")) post("/api/runtime", { action: "stop" }).catch((e) => toast(e.message)); });
$("#rtRestart").addEventListener("click", () => post("/api/runtime", { action: "restart" }).catch((e) => toast(e.message)));

async function prepareMotor() {
  if (!isAdmin()) { $("#motorAxis").innerHTML = '<span class="muted">Jen pro správce.</span>'; return; }
  try {
    const j = await get("/api/setup");
    const axes = j.machine.axes.filter((a) => a.enabled);
    S.motor.scales = axes.map((a) => (a.steps_per_rev * a.microsteps * (a.gear || 1)) / a.pitch);
    $("#motorAxis").innerHTML = axes.map((a, i) => `<button data-mj="${i}" class="${i === S.motor.joint ? "on" : ""}">${a.letter}</button>`).join("");
  } catch (e) { /* hláška už zobrazena */ }
}
$("#motorAxis").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mj]"); if (!b) return;
  S.motor.joint = +b.dataset.mj; $$("#motorAxis button").forEach((x) => x.classList.toggle("on", x === b));
});
$("#motorHz").addEventListener("input", () => ($("#motorHzOut").textContent = $("#motorHz").value + " Hz"));
$("#motorHzOut").textContent = $("#motorHz").value + " Hz";
function motorSend() { post("/api/diag/motor", { joint: S.motor.joint, freq: S.motor.dir * +$("#motorHz").value }).catch((e) => { toast(e.message); stopMotor(); }); }
function stopMotor() {
  if (S.motor.timer) { clearInterval(S.motor.timer); S.motor.timer = null; }
  if (S.motor.dir) { S.motor.dir = 0; post("/api/diag/motor", { joint: S.motor.joint, freq: 0 }).catch(() => {}); }
  $$("[data-motor]").forEach((b) => b.classList.remove("active"));
}
$$("[data-motor]").forEach((b) => {
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault(); b.setPointerCapture(e.pointerId);
    stopMotor(); S.motor.dir = +b.dataset.motor; b.classList.add("active");
    motorSend(); S.motor.timer = setInterval(motorSend, 100);
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => b.addEventListener(ev, stopMotor));
});
$$("[data-latency]").forEach((b) => b.addEventListener("click", () => startJob("/api/jobs/latency", { seconds: +b.dataset.latency })));

/* ================================================================ úlohy na pozadí */

async function startJob(url, body, raw) {
  try {
    const j = await post(url, body, raw);
    watchJob(j.job);
  } catch (e) { toast(e.message); }
}
function watchJob(id) {
  $("#jobModal").hidden = false;
  $("#jobModalLog").textContent = "…";
  const tick = async () => {
    try {
      const j = (await get("/api/job?id=" + id)).job;
      if (!j) return;
      $("#jobTitle").textContent = j.title;
      const log = $("#jobModalLog");
      log.textContent = j.log.join("\n") || "…";
      log.scrollTop = log.scrollHeight;
      pill($("#jobState"), j.running ? "warn" : j.ok ? "ok" : "bad", j.running ? "běží" : j.ok ? "hotovo" : "chyba");
      if (j.running) setTimeout(tick, 500);
      else if (S.screen === "setup") loadSetup();
    } catch (e) { setTimeout(tick, 1000); }
  };
  tick();
}
$("#jobClose").addEventListener("click", () => ($("#jobModal").hidden = true));
$$("[data-job]").forEach((b) => b.addEventListener("click", () => startJob("/api/jobs/" + b.dataset.job, {})));
$$("[data-power]").forEach((b) => b.addEventListener("click", () => {
  if (confirm(b.dataset.power === "reboot" ? "Restartovat Raspberry Pi?" : "Vypnout Raspberry Pi?"))
    post("/api/system/power", { action: b.dataset.power }).then(() => toast("Provádím…", "info")).catch((e) => toast(e.message));
}));
$("#fwFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  if (!confirm("Nahrát firmware " + f.name + " do EC300 přes SWD?")) return;
  startJob("/api/jobs/flash", f, true);
});

/* ================================================================ F6 Soubory */

let tpFile = null;
async function loadFiles() {
  try {
    S.files = (await get("/api/files")).files;
    $("#fileList").innerHTML = S.files.length ? S.files.map((f) => `<button class="item ${f.name === S.selFile ? "sel" : ""}" data-file="${esc(f.name)}">
      <span>${esc(f.name)}</span><span class="meta">${(f.size / 1024).toFixed(1)} kB · ${new Date(f.mtime * 1000).toLocaleDateString("cs-CZ")}</span></button>`).join("")
      : '<div class="empty">Zatím žádné programy. Nahraj soubor z tabletu.</div>';
  } catch (e) { toast(e.message); }
}
$("#fileList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-file]"); if (!b) return;
  S.selFile = b.dataset.file;
  $$("#fileList .item").forEach((x) => x.classList.toggle("sel", x === b));
  $("#fileSel").textContent = S.selFile;
  $("#fileLoad").disabled = $("#fileDel").disabled = false;
  if (!tpFile) tpFile = Toolpath.create($("#fileTp"), $("#fileTpInfo"));
  try { tpFile.load((await get("/api/file?name=" + encodeURIComponent(S.selFile))).text); } catch (err) { toast(err.message); }
});
$$("#fileTp [data-view]").forEach((b) => b.addEventListener("click", () => tpFile && tpFile.view(b.dataset.view)));
$("#fileLoad").addEventListener("click", async () => {
  try { await post("/api/files/open", { name: S.selFile }); toast("Program načten.", "info"); showScreen("run"); } catch (e) { toast(e.message); }
});
$("#fileDel").addEventListener("click", async () => {
  if (!S.selFile || !confirm("Smazat " + S.selFile + "?")) return;
  try { await post("/api/files/delete", { name: S.selFile }); S.selFile = null; tpFile && tpFile.clear(); $("#fileSel").textContent = ""; $("#fileLoad").disabled = $("#fileDel").disabled = true; loadFiles(); }
  catch (e) { toast(e.message); }
});
$("#upload").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try { await post("/api/files/upload?name=" + encodeURIComponent(f.name), f, true); toast("Nahráno: " + f.name, "info"); loadFiles(); }
  catch (err) { toast(err.message); }
});

/* ================================================================ F1 Nastavení */

const STEPS = ["Stroj", "Motory", "Dráha a reference", "Vstupy a výstupy", "Kontrola a uložení"];
const LETTERS = "XYZABC";

function showSetup() {
  const admin = isAdmin();
  $("#setupLocked").hidden = admin;
  $("#setupBody").hidden = !admin;
  if (admin && !S.draft) loadSetup();
}
async function loadSetup() {
  try {
    S.setup = await get("/api/setup");
    S.saved = clone(S.setup.machine);
    S.draft = clone(S.setup.machine);
    $("#setupState").textContent = S.setup.configured ? "Uložená konfigurace: " + S.saved.machine_name : "Stroj zatím není nastavený";
    renderSetup();
  } catch (e) { toast(e.message); }
}
$$("#setupTabs button").forEach((b) => b.addEventListener("click", () => {
  S.setupTab = b.dataset.st;
  $$("#setupTabs button").forEach((x) => x.classList.toggle("on", x === b));
  ["wizard", "history", "updates", "security"].forEach((t) => ($("#st-" + t).hidden = t !== S.setupTab));
  manageDiagPolling();
  renderSetup();
}));

function renderSetup() {
  if (!S.draft) return;
  $("#steps").innerHTML = STEPS.map((s, i) => `<button class="step ${i === S.step ? "on" : ""}" data-step="${i}"><b>${i + 1}</b>${s}</button>`).join("");
  $("#stepPrev").disabled = S.step === 0;
  $("#stepNext").hidden = S.step === STEPS.length - 1;
  const body = $("#stepBody");
  body.innerHTML = [stepMachine, stepMotors, stepTravel, stepIO, stepReview][S.step]();
  if (S.step === 1) updateCalc();
  if (S.step === 4) runValidation();
  renderHistory();
  manageDiagPolling();
}
$("#steps").addEventListener("click", (e) => { const b = e.target.closest("[data-step]"); if (b) { S.step = +b.dataset.step; renderSetup(); } });
$("#stepPrev").addEventListener("click", () => { S.step = Math.max(0, S.step - 1); renderSetup(); });
$("#stepNext").addEventListener("click", () => { S.step = Math.min(STEPS.length - 1, S.step + 1); renderSetup(); });

// obousměrná vazba: data-path="axes.0.pitch"
function getPath(o, p) { return p.split(".").reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, p, v) { const ks = p.split("."); const last = ks.pop(); const t = ks.reduce((a, k) => a[k], o); t[last] = v; }
function num(path, label, unit, opts = {}) {
  const v = getPath(S.draft, path);
  return `<div class="field"><label>${label}${unit ? " [" + unit + "]" : ""}</label><input class="inp num" type="number" inputmode="decimal" step="${opts.step || "any"}" data-path="${path}" data-type="num" value="${v ?? ""}">${opts.hint ? "<small>" + opts.hint + "</small>" : ""}</div>`;
}
function chk(path, label) {
  return `<label class="chk"><input type="checkbox" data-path="${path}" data-type="bool" ${getPath(S.draft, path) ? "checked" : ""}> ${label}</label>`;
}
$("#stepBody").addEventListener("input", (e) => {
  const el = e.target.closest("[data-path]"); if (!el) return;
  const t = el.dataset.type;
  let v = t === "bool" ? el.checked : t === "num" ? (el.value === "" ? 0 : parseFloat(el.value)) : el.value;
  setPath(S.draft, el.dataset.path, v);
  if (S.step === 1) updateCalc();
});

function stepMachine() {
  const n = S.draft.axes.filter((a) => a.enabled).length;
  return `<div class="panel"><h2>Základ</h2>
    <div class="grid2">
      <div class="field"><label>Název stroje</label><input class="inp" data-path="machine_name" value="${esc(S.draft.machine_name)}"></div>
      <div class="field"><label>Řídicí deska</label><input class="inp" value="EC300 (Remora, ${esc(S.draft.board_ip)})" disabled></div>
    </div>
    <div class="h2">Počet os</div>
    <div class="seg" id="axisCount">${[1, 2, 3, 4, 5, 6].map((k) => `<button data-axn="${k}" class="${k === n ? "on" : ""}">${k} · ${LETTERS.slice(0, k)}</button>`).join("")}</div>
    ${chk("require_homing", "Před MDI a spuštěním programu vyžadovat referování (doporučeno)")}
    <div class="note">Osy A–C se nastaví jako otočné. Šestá osa (C) potřebuje firmware s opravou směrového pinu P1_19.</div></div>`;
}
$("#stepBody").addEventListener("click", (e) => {
  const b = e.target.closest("[data-axn]"); if (!b) return;
  const n = +b.dataset.axn, axes = S.draft.axes;
  while (axes.length < n) { const a = clone(axes[axes.length - 1] || {}); a.letter = LETTERS[axes.length]; axes.push(a); }
  axes.forEach((a, i) => { a.enabled = i < n; a.letter = LETTERS[i]; });
  S.draft.axes = axes.slice(0, Math.max(n, 1));
  renderSetup();
});

function stepMotors() {
  return S.draft.axes.map((a, i) => !a.enabled ? "" : `<div class="axcard"><h3>Osa ${a.letter} <span class="calc" data-calc="${i}"></span></h3>
    <div class="grid4">
      ${num(`axes.${i}.steps_per_rev`, "Kroků na otáčku motoru", "", { step: 1, hint: "běžně 200 (1,8°)" })}
      ${num(`axes.${i}.microsteps`, "Mikrokrokování", "×", { step: 1, hint: "nastavení driveru" })}
      ${num(`axes.${i}.pitch`, "ABC".includes(a.letter) ? "Stupňů na otáčku" : "Stoupání šroubu", "ABC".includes(a.letter) ? "°/ot" : "mm/ot")}
      ${num(`axes.${i}.gear`, "Převod motor : šroub", "", { hint: "1 = přímo" })}
      ${num(`axes.${i}.max_vel`, "Max. rychlost", "ABC".includes(a.letter) ? "°/min" : "mm/min", { step: 10 })}
      ${num(`axes.${i}.accel`, "Zrychlení", "ABC".includes(a.letter) ? "°/s²" : "mm/s²", { step: 10 })}
      <div class="field"><label>Směr</label>${chk(`axes.${i}.invert_dir`, "Obrátit směr")}</div>
    </div>
    <details><summary>Časování signálů STEP/DIR (µs)</summary><div class="grid4">
      ${num(`axes.${i}.step_len`, "Délka pulzu", "µs", { step: 1 })}${num(`axes.${i}.step_space`, "Mezera", "µs", { step: 1 })}
      ${num(`axes.${i}.dir_setup`, "DIR před krokem", "µs", { step: 1 })}${num(`axes.${i}.dir_hold`, "DIR po kroku", "µs", { step: 1 })}
    </div><small class="muted">Hodnoty z datasheetu driveru, např. DM542: pulz ≥ 2,5 µs, DIR ≥ 5 µs.</small></details></div>`).join("");
}
function updateCalc() {
  $$("[data-calc]").forEach((el) => {
    const a = S.draft.axes[+el.dataset.calc];
    const sc = (a.steps_per_rev * a.microsteps * (a.gear || 1)) / a.pitch;
    const khz = (sc * a.max_vel) / 60000;
    const lim = Math.min(500, 1000 / Math.max(2, a.step_len + a.step_space));
    el.innerHTML = isFinite(sc) ? `<b>${sc.toFixed(2)}</b> kroků/mm · <b style="color:${khz > lim ? "var(--bad)" : khz > lim * 0.8 ? "var(--warn)" : "var(--ok)"}">${khz.toFixed(1)} kHz</b> z ${lim.toFixed(0)}` : "zadej kroky a stoupání";
  });
}

function stepTravel() {
  return `<div class="note">Rychlost hledání reference: znaménko určuje směr (záporná = k minimu). Pomalá rychlost dojezdu by měla mít stejné znaménko. Pořadí: 0 = první (obvykle Z), 1 = další.</div>` +
    S.draft.axes.map((a, i) => !a.enabled ? "" : `<div class="axcard"><h3>Osa ${a.letter}</h3>
    <div class="grid4">
      ${num(`axes.${i}.min_limit`, "Dráha min.", "mm")}${num(`axes.${i}.max_limit`, "Dráha max.", "mm")}
      ${num(`axes.${i}.home_position`, "Poloha po referování", "mm")}${num(`axes.${i}.home_offset`, "Poloha spínače", "mm", { hint: "kde spínač sepne" })}
      ${num(`axes.${i}.home_search_vel`, "Hledání reference", "mm/min")}${num(`axes.${i}.home_latch_vel`, "Pomalý dojezd", "mm/min")}
      ${num(`axes.${i}.home_sequence`, "Pořadí referování", "", { step: 1 })}
    </div></div>`).join("");
}

function stepIO() {
  const fns = S.setup.input_functions, ofns = S.setup.output_functions;
  const letters = S.draft.axes.filter((a) => a.enabled).map((a) => a.letter);
  const usable = Object.entries(fns).filter(([k]) => !/_([A-Z])$/.test(k) || letters.includes(k.slice(-1)));
  const rows = S.setup.inputs.map((inp) => {
    const cur = S.draft.inputs[inp.bit] || {};
    return `<tr><td class="mono"><b>${inp.terminal}</b></td><td><span class="led" style="min-height:0;padding:0;background:none" data-led="${inp.bit}"><i></i></span></td>
      <td><select class="inp" data-in="${inp.bit}"><option value="">—</option>${usable.map(([k, v]) => `<option value="${k}" ${cur.function === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></td>
      <td><label class="chk"><input type="checkbox" data-inv="${inp.bit}" ${cur.invert ? "checked" : ""}> obrátit</label></td></tr>`;
  }).join("");
  const orows = S.setup.outputs.map((o) => `<tr><td class="mono"><b>${o.terminal}</b></td><td><select class="inp" data-outf="${o.bit}"><option value="">—</option>
      ${Object.entries(ofns).map(([k, v]) => `<option value="${k}" ${S.draft.outputs[o.bit] === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></td></tr>`).join("");
  return `<div class="two" style="display:grid;gap:10px">
    <div class="panel"><h2>Vstupy <span class="right muted" id="ledSrc"></span></h2>
      <div class="note">Sepni spínač na stroji a sleduj, která svorka se rozsvítí. Zelená = sepnuto. Pokud svítí v klidu, zaškrtni „obrátit“.</div>
      <div class="tbl"><table><thead><tr><th>Svorka</th><th>Stav</th><th>Funkce</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <div style="display:grid;gap:10px;align-content:start">
      <div class="panel"><h2>Výstupy</h2><div class="tbl"><table><thead><tr><th>Svorka</th><th>Funkce</th></tr></thead><tbody>${orows}</tbody></table></div></div>
      <div class="panel"><h2>Vřeteno</h2><div class="grid2">${num("spindle.max_rpm", "Max. otáčky (10 V / 100 % PWM)", "ot/min", { step: 100 })}
        <div class="field"><label>Řízení otáček</label>${chk("spindle.pwm", "PWM výstup desky (0–10 V)")}</div></div></div>
    </div></div>`;
}
$("#stepBody").addEventListener("change", (e) => {
  const s = e.target.closest("[data-in]"), inv = e.target.closest("[data-inv]"), o = e.target.closest("[data-outf]");
  if (s) {
    const bit = s.dataset.in;
    if (s.value) S.draft.inputs[bit] = { function: s.value, invert: !!(S.draft.inputs[bit] || {}).invert };
    else delete S.draft.inputs[bit];
  }
  if (inv) { const bit = inv.dataset.inv; if (S.draft.inputs[bit]) S.draft.inputs[bit].invert = inv.checked; else { inv.checked = false; toast("Nejdřív vyber funkci vstupu."); } }
  if (o) { if (o.value) S.draft.outputs[o.dataset.outf] = o.value; else delete S.draft.outputs[o.dataset.outf]; }
});
function updateSetupLeds() {
  if (S.step !== 3 || !S.diag) return;
  const stopped = S.diag.runtime.state === "stopped" || S.diag.runtime.state === "failed";
  const src = $("#ledSrc"); if (src) src.textContent = S.diag.board.ok ? (stopped ? "živě z desky" : "živě přes LinuxCNC") : "deska neodpovídá";
  S.diag.inputs.forEach((x) => { const el = $(`[data-led="${x.bit}"]`); if (el) el.classList.toggle("on", x.on); });
}

function diffList(a, b, prefix = "") {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const p = prefix ? prefix + "." + k : k, va = a ? a[k] : undefined, vb = b ? b[k] : undefined;
    if (va && vb && typeof va === "object" && typeof vb === "object") out.push(...diffList(va, vb, p));
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push([p, va, vb]);
  }
  return out;
}
function stepReview() {
  const rt = S.st ? S.st.runtime.state : "stopped";
  const running = !(rt === "stopped" || rt === "failed");
  const diff = S.setup.configured ? diffList(S.saved, S.draft) : null;
  return `<div class="two" style="display:grid;gap:10px">
    <div class="panel"><h2>Kontrola</h2><div id="valOut" class="list"><div class="empty">Kontroluji…</div></div>
      <h2>Změny proti uložené konfiguraci</h2>
      <div class="list">${diff === null ? '<div class="note">První nastavení stroje.</div>' : diff.length ? diff.map(([p, a, b]) => `<div class="item mono" style="font-size:13px"><span>${esc(p)}</span><span class="meta">${esc(JSON.stringify(a))} → ${esc(JSON.stringify(b))}</span></div>`).join("") : '<div class="empty">Beze změn.</div>'}</div></div>
    <div class="panel"><h2>Uložení</h2>
      ${running ? '<div class="note warn">Řízení běží. Nastavení ovlivňující pohyb lze měnit jen při zastaveném řízení.</div><div><button class="btn danger" id="setupStopRt">Zastavit řízení</button></div>' : ""}
      <div class="muted">Uložení vytvoří zálohu, vygeneruje remora.ini, remora.hal a konfiguraci desky a nahraje ji do EC300 (deska se restartuje).</div>
      <div class="row"><button class="btn primary" id="setupApply" ${running ? "disabled" : ""}>Uložit a nahrát do EC300</button>
        </div>
      <button class="btn ghost" id="setupRevert">Zahodit neuložené změny</button>
      <h2>Vygenerované soubory</h2>
      <div class="row" id="genFiles"></div></div></div>`;
}
async function runValidation() {
  try {
    const j = await post("/api/setup/validate", { machine: S.draft });
    S.validation = j;
    const out = [];
    j.errors.forEach((e) => out.push(`<div class="note bad">${esc(e)}</div>`));
    j.warnings.forEach((w) => out.push(`<div class="note warn">${esc(w)}</div>`));
    if (!j.errors.length) out.push('<div class="note ok">Nastavení je v pořádku.</div>');
    out.push(...j.axes.filter((a, i) => S.draft.axes[i] && S.draft.axes[i].enabled).map((a) => `<div class="item mono" style="font-size:13px"><span>Osa ${a.letter}</span><span class="meta">${a.scale} kroků/mm · ${a.step_khz} kHz</span></div>`));
    $("#valOut").innerHTML = out.join("");
    $("#genFiles").innerHTML = Object.keys(j.files).map((f) => `<button class="btn sm" data-gen="${f}">${f}</button>`).join("");
    ["#setupApply"].forEach((s) => { const b = $(s); if (b && j.errors.length) b.disabled = true; });
  } catch (e) { const v = $("#valOut"); if (v) v.innerHTML = `<div class="note bad">${esc(e.message)}</div>`; }
}
$("#stepBody").addEventListener("click", async (e) => {
  const g = e.target.closest("[data-gen]");
  if (g && S.validation) { $("#fileModalTitle").textContent = g.dataset.gen; let t = S.validation.files[g.dataset.gen]; if (g.dataset.gen.endsWith(".json")) t = JSON.stringify(JSON.parse(t), null, 2); $("#fileModalText").textContent = t; $("#fileModal").hidden = false; }
  if (e.target.closest("#setupApply")) startJob("/api/setup/apply", { machine: S.draft, start: false });
  if (e.target.closest("#setupRevert")) { S.draft = clone(S.saved); renderSetup(); }
  if (e.target.closest("#setupStopRt") && confirm("Zastavit řízení?")) { await post("/api/runtime", { action: "stop" }).catch((err) => toast(err.message)); setTimeout(renderSetup, 1500); }
});
$("#fileModalClose").addEventListener("click", () => ($("#fileModal").hidden = true));

function renderHistory() {
  const h = (S.setup && S.setup.history) || [];
  $("#historyList").innerHTML = h.length ? h.map((x) => `<div class="item"><span class="mono">${esc(x.id)}</span><span class="muted">${esc(x.reason)}</span>
    ${x.good ? '<span class="pill ok">funkční</span>' : ""}<span class="meta"><button class="btn xs" data-rollback="${esc(x.id)}">Obnovit</button></span></div>`).join("")
    : '<div class="empty">Zatím žádné zálohy.</div>';
}
$("#historyList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-rollback]");
  if (b && confirm("Obnovit konfiguraci " + b.dataset.rollback + "? Aktuální se nejdřív zazálohuje.")) startJob("/api/setup/rollback", { id: b.dataset.rollback });
});
$("#pwSave").addEventListener("click", async () => {
  const body = {};
  if ($("#pwAdmin").value) body.admin = $("#pwAdmin").value;
  if ($("#pwOperatorClear").checked) body.operator = "";
  else if ($("#pwOperator").value) body.operator = $("#pwOperator").value;
  if (!Object.keys(body).length) return toast("Nezadal jsi žádné heslo.");
  try { await post("/api/auth/passwords", body); toast("Hesla uložena. Přihlas se znovu.", "info"); $("#pwAdmin").value = $("#pwOperator").value = ""; await refreshAuth(); }
  catch (e) { toast(e.message); }
});

/* ================================================================ start */

(async function init() {
  try { await refreshAuth(); } catch (e) { $("#offline").hidden = false; }
  showScreen((location.hash || "#run").slice(1));
  poll();
})();
