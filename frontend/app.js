/* OpenCNC Web - logika rozhraní (bez frameworku).
   Rozvržení podle průmyslových řídicích systémů: záložky F1-F6, vlevo náhled drah, vpravo souřadnice a ovládání. */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const n3 = (v) => Number(v).toFixed(3);

const S = {
  auth: null, st: null, m: null, screen: "run", lastMsg: 0, messages: [], fail: 0,
  jogMode: "step", inc: 0.01, jog: null, jogTimer: null, mdiHist: [],
  rpm: 12000, programPath: null, programText: "", programLines: [], runStart: null, tpKey: "",
  files: [], sel: null, selText: "", tools: [], offsets: null,
  setup: null, draft: null, saved: null, section: "general", validation: null, diag: null, diagTimer: null,
  motor: { joint: 0, dir: 0, timer: null, hz: 1000 },
  wiz: "face", wizVals: {}, wizText: "",
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
    if (j.needs_setup) openUnlock();
    else if (j.login === "admin") openUnlock();
    throw new Error(j.error || "Chyba");
  }
  return j;
}
const get = (u) => http("GET", u);
const post = (u, b, raw) => http("POST", u, b, raw);
async function api(cmd, args = {}) {
  try { await post("/api/cmd", { cmd, ...args }); return true; } catch (e) { toast(e.message); return false; }
}
function toast(text, info) {
  const t = $("#toast");
  t.textContent = text; t.className = "toast" + (info ? " info" : ""); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4500);
}
const isAdmin = () => S.auth && S.auth.role === "admin";

/* ---------- zadání hodnoty ---------- */
let valCb = null;
function askValue(title, hint, initial, cb, text) {
  $("#valTitle").textContent = title; $("#valHint").textContent = hint || "";
  const i = $("#valInput"); i.value = initial ?? ""; i.inputMode = text ? "text" : "decimal";
  valCb = cb; $("#valModal").hidden = false; setTimeout(() => { i.focus(); i.select(); }, 30);
}
$("#valForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#valInput").value.trim().replace(",", ".");
  $("#valModal").hidden = true;
  if (valCb && v !== "") valCb(v);
});
$("#valCancel").addEventListener("click", () => ($("#valModal").hidden = true));

/* ---------- odemčení nastavení (heslo správce) ---------- */
function openUnlock() {
  const setup = S.auth && S.auth.needs_setup;
  $("#unlockTitle").textContent = setup ? "Nastav heslo správce" : "Odemknout nastavení";
  $("#unlockHint").textContent = setup ? "Heslo chrání nastavení stroje, testy výstupů a aktualizace. Ovládání stroje heslo nevyžaduje."
    : "Zadej heslo správce.";
  $("#unlockPw2").hidden = !setup;
  $("#unlockPw").value = $("#unlockPw2").value = "";
  $("#unlockModal").hidden = false;
  setTimeout(() => $("#unlockPw").focus(), 30);
}
$("#unlockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("#unlockPw").value;
  try {
    if (S.auth.needs_setup) {
      if (pw !== $("#unlockPw2").value) return toast("Hesla se neshodují.");
      await post("/api/auth/setup", { admin: pw, operator: "" });
    } else await post("/api/auth/login", { role: "admin", password: pw });
    $("#unlockModal").hidden = true;
    await refreshAuth();
    toast("Nastavení odemčeno.", true);
  } catch (err) { toast(err.message); }
});
$("#unlockCancel").addEventListener("click", () => ($("#unlockModal").hidden = true));
$("#sLock").addEventListener("click", async () => {
  if (isAdmin()) { await post("/api/auth/logout", {}).catch(() => {}); await refreshAuth(); toast("Nastavení zamčeno.", true); }
  else openUnlock();
});
$("#sPower").addEventListener("click", () => {
  if (!isAdmin()) return openUnlock();
  if (!confirm("Vypnout Raspberry Pi?\n\nŘízení se bezpečně zastaví. Až zhasnou kontrolky (~15 s), můžeš odpojit napájení.")) return;
  post("/api/system/power", { action: "poweroff" })
    .then(() => toast("Raspberry se vypíná… počkej, až zhasnou kontrolky, pak odpoj napájení.", true))
    .catch((err) => toast(err.message));
});
async function refreshAuth() {
  S.auth = await get("/api/auth");
  const l = $("#sLock");
  l.textContent = isAdmin() ? "🔓 Správce" : "🔒 Nastavení zamčeno";
  l.classList.toggle("open", isAdmin());
  if (S.screen === "setup") renderSetup();
}

/* ================================================================ obrazovky */

const SCREENS = ["setup", "run", "jog", "tools", "wiz", "files"];
const FULL = { setup: "full-setup", tools: "full-tools" };
function showScreen(name) {
  if (!SCREENS.includes(name)) name = "run";
  if (S.screen === "jog" && name !== "jog") stopJog();
  stopMotor();
  S.screen = name;
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.s === name));
  const full = FULL[name];
  $("#main").classList.toggle("full", !!full);
  $("#viewport").hidden = !!full; $("#side").hidden = !!full;
  Object.values(FULL).forEach((id) => ($("#" + id).hidden = id !== full));
  ["run", "jog", "wiz", "files"].forEach((s) => ($("#ctx-" + s).hidden = s !== name));
  history.replaceState(null, "", "#" + name);
  if (name === "setup") loadSetup();
  if (name === "tools") loadTools();
  if (name === "files") loadFiles();
  if (name === "wiz") { renderWizard(); if (!S.wizText) wizGenerate(true); }
  updateViewport();
  manageDiag();
  if (S.st) render();
}
$$("#tabs button").forEach((b) => b.addEventListener("click", () => showScreen(b.dataset.s)));
document.addEventListener("keydown", (e) => {
  const m = /^F([1-6])$/.exec(e.key);
  if (m) { e.preventDefault(); showScreen(SCREENS[+m[1] - 1]); }
  if (e.key === "Escape" && S.m && S.m.interp === "running") api("pause");
});

/* ---------- náhled drah ---------- */
const tp = Toolpath.create($("#tp"), $("#tpInfo"));
$$("#tp .views button").forEach((b) => b.addEventListener("click", () => tp.view(b.dataset.view)));
function updateViewport() {
  let key, text, empty;
  if (S.screen === "wiz") { key = "wiz:" + S.wizText.length + S.wizText.slice(-40); text = S.wizText; empty = "Vyplň průvodce a dej Náhled"; }
  else if (S.screen === "files") { key = "file:" + S.sel + S.selText.length; text = S.selText; empty = "Vyber soubor vpravo"; }
  else { key = "prog:" + S.programPath + S.programText.length; text = S.programText; empty = S.m ? "Načti program v F6 Soubory" : "Řízení neběží"; }
  $("#tpEmpty").hidden = !!text;
  $("#tpEmptyText").textContent = empty;
  if (key !== S.tpKey) { S.tpKey = key; text ? tp.load(text) : tp.clear(); }
  tp.redraw();
}

/* ================================================================ stav */

async function poll() {
  try {
    const r = await fetch("/api/status?since=" + S.lastMsg, { cache: "no-store" });
    const j = await r.json();
    if (j.ok) {
      S.st = j; S.m = j.machine; S.fail = 0; $("#offline").hidden = true;
      if (j.messages.length) {
        S.messages.push(...j.messages); S.messages = S.messages.slice(-100);
        const bad = j.messages.filter((x) => x.kind !== "info");
        if (S.lastMsg && bad.length) toast(bad[bad.length - 1].text);
      }
      S.lastMsg = j.last_msg;
      render();
    }
  } catch (e) {
    if (++S.fail >= 4) { $("#offline").hidden = false; stopJog(false); stopMotor(); }
  } finally { setTimeout(poll, document.hidden ? 1500 : 200); }
}
setInterval(() => ($("#sClock").textContent = new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })), 1000);

const WCS = ["G54", "G55", "G56", "G57", "G58", "G59"];
function setSt(el, text, cls) { el.textContent = text; el.className = "st " + (cls || ""); }

function render() {
  const st = S.st, m = S.m, rt = st.runtime;
  setSt($("#sWcs"), "Pracovní offset: " + (m ? WCS[m.g5x_index - 1] || "G5x" : "–"), "wcs");
  setSt($("#sRuntime"), "Řízení: " + ({ stopped: "stojí", starting: "startuje", running: "běží", stopping: "zastavuje", failed: "chyba" }[rt.state] || rt.state),
        { running: "ok", failed: "bad", stopped: "warn", starting: "warn" }[rt.state]);
  setSt($("#sBoard"), "Deska EC300: " + (st.board.ok ? "OK" : "bez spojení"), st.board.ok ? "ok" : "bad");
  $("#sAlarm").textContent = st.alarms.length ? "⚠ " + st.alarms[0] + (st.alarms.length > 1 ? " (+" + (st.alarms.length - 1) + ")" : "") : "";

  const running = rt.state === "running" && m;
  $("#machine").hidden = !running;
  $("#notRunning").hidden = !!running;
  if (!running) {
    $("#notRunningText").textContent = !rt.configured ? "Stroj ještě není nastavený. Projdi F1 Nastavení."
      : rt.commissioning ? "Nová konfigurace: správce musí potvrdit kontrolu bezpečnosti (F1 → Řízení a deska)."
      : rt.state === "starting" ? "Řízení startuje…" : rt.error || "Řízení je zastavené.";
    $("#nrStart").textContent = !rt.configured || rt.commissioning ? "Otevřít nastavení" : "Spustit řízení";
    $("#nrStart").disabled = rt.state === "starting" || rt.state === "stopping";
  } else renderMachine();

  if (S.screen === "run") renderRun();
  if (S.screen === "jog") renderJog();
  if (S.screen === "tools") {
    $("#tCur").textContent = m ? "T" + m.tool : "–";
    if (m && !S.offsets && !S.offLoading) { S.offLoading = true; get("/api/offsets").then((o) => { S.offsets = o; renderOffsets(); }).catch(() => {}).finally(() => (S.offLoading = false)); }
    if (!m && S.offsets) { S.offsets = null; renderOffsets(); }
  }
  if (S.screen === "setup" && S.section === "runtime") renderRuntimeLive();
  if (m && m.file_path !== S.programPath) loadProgram();
  if (!m && S.programPath) { S.programPath = null; S.programText = ""; S.programLines = []; updateViewport(); }
  if (m && ["run", "jog"].includes(S.screen)) {
    const p = { X: 0, Y: 0, Z: 0 };
    m.dro.forEach((a) => (p[a.axis] = a.work));
    tp.setTool([p.X, p.Y, p.Z]);
    tp.setLine(m.interp === "idle" ? 0 : m.motion_line || m.current_line);
  } else tp.setTool(null);
  $("#modalBar").innerHTML = m ? m.gcodes.map((g) => `<span>${esc(g)}</span>`).join("") : "";
}
$("#nrStart").addEventListener("click", () => {
  const rt = S.st.runtime;
  if (!rt.configured || rt.commissioning) { S.section = rt.configured ? "runtime" : "general"; return showScreen("setup"); }
  post("/api/runtime", { action: "start" }).catch((e) => toast(e.message));
});

/* ---------- stavové dlaždice, souřadnice ---------- */
function tile(el, cls, title, sub) { el.className = "tile " + cls; el.innerHTML = esc(title) + "<small>" + esc(sub) + "</small>"; }
function renderMachine() {
  const m = S.m;
  if (m.state === "estop") tile($("#tState"), "warn", "Nepřipraven", "E-stop aktivní");
  else if (m.state === "off") tile($("#tState"), "warn", "Vypnuto", "klepni: zapnout");
  else if (!m.all_homed) tile($("#tState"), "warn", "Referovat", "stroj nezreferován");
  else if (m.interp === "running") tile($("#tState"), "go", "Běží", "program");
  else if (m.interp === "paused") tile($("#tState"), "warn", "Pauza", "klepni START");
  else tile($("#tState"), "", "Připraven", "stroj připraven");
  tile($("#tBoard"), S.st.board.ok ? "" : "bad", "Deska", S.st.board.ok ? "EC300 OK" : "bez spojení");
  if (m.state === "estop") tile($("#tEstop"), "bad", "E-stop", "klepni: reset");
  else tile($("#tEstop"), "", "E-stop", "klepni: zastavit");

  const main = m.dro.slice(0, 3), rot = m.dro.slice(3);
  const dro = $("#dro"), key = m.dro.map((a) => a.axis).join("");
  if (dro.dataset.k !== key) {
    dro.dataset.k = key;
    dro.innerHTML = main.map((a) => axisHtml(a)).join("");
    $("#dro2").innerHTML = rot.map((a) => axisHtml(a)).join("");
  }
  $("#dro2").hidden = !rot.length;
  m.dro.forEach((a, i) => {
    const row = $(`[data-ax="${a.index}"]`);
    if (!row) return;
    $(".val", row).textContent = n3(a.work);
    $(".zero", row).classList.toggle("homed", !!m.homed[i]);
  });
  $("#fFeed").textContent = Math.round(m.feedrate_cmd) + ", " + Math.round(m.feed_override * 100) + "%";
  $("#fTool").textContent = m.tool;
  $("#spRpm").textContent = Math.round(Math.abs(m.spindle.speed));
  $("#spReq").textContent = Math.round(Math.abs(m.spindle.speed)) + ", " + Math.round(m.spindle.override * 100) + "%";
  $("#spDir").textContent = !m.spindle.enabled ? "STOP" : m.spindle.direction < 0 ? "CCW" : "CW";
  $("#machCoords").innerHTML = m.dro.map((a) => `<b>${a.axis}</b><span style="text-align:right">${n3(a.machine)}</span><i>mm</i>`).join("");
}
function axisHtml(a) {
  return `<div class="axis" data-ax="${a.index}"><button class="zero" data-zero="${a.index}" title="Nastavit nulu obrobku"><b>${a.axis}</b><small>NULA</small></button>
    <div class="val" data-setpos="${a.index}">0.000</div><span class="unit">mm</span></div>`;
}
document.addEventListener("click", (e) => {
  const z = e.target.closest("[data-zero]"), sp = e.target.closest("[data-setpos]");
  if (z) api("touchoff", { axis: +z.dataset.zero, value: 0 });
  if (sp && S.m) {
    const a = S.m.dro.find((x) => x.index === +sp.dataset.setpos);
    askValue("Poloha osy " + a.axis, "Zadej, jakou souřadnici má mít aktuální poloha nástroje (nastaví pracovní offset).", n3(a.work),
             (v) => api("touchoff", { axis: a.index, value: parseFloat(v) }));
  }
});
$("#tState").addEventListener("click", () => {
  const m = S.m; if (!m) return;
  if (m.state === "off") api("machine_on");
  else if (m.state === "on" && !m.all_homed) showScreen("jog");
  else if (m.interp === "paused") api("resume");
});
$("#tEstop").addEventListener("click", () => {
  const m = S.m; if (!m) return;
  if (m.state === "estop") api("estop_reset"); else { stopJog(false); api("estop"); }
});
$("#tBoard").addEventListener("click", () => { S.section = "runtime"; showScreen("setup"); });

/* ================================================================ F2 Program a MDI */

async function loadProgram() {
  S.programPath = S.m.file_path;
  S.programText = ""; S.programLines = []; lastHl = -1;
  if (S.programPath) {
    try { S.programText = (await get("/api/file")).text; } catch (e) { toast(e.message); }
  }
  S.programLines = S.programText ? S.programText.split("\n") : [];
  $("#gcode").innerHTML = S.programLines.slice(0, 20000).map((l, i) => `<div><span class="ln">${i + 1}</span>${esc(l)}</div>`).join("");
  updateViewport();
}
let lastHl = -1;
function renderRun() {
  const m = S.m, on = m && m.state === "on", idle = m && m.interp === "idle", ready = on && idle && m.all_homed;
  $$("[data-sp]").forEach((b) => (b.disabled = !ready));
  $("#bRpm").disabled = !m;
  $("#rpmSet").textContent = S.rpm;
  $("#bCool").disabled = !ready; $("#bCool").classList.toggle("on", !!(m && m.flood));
  $("#bOrigin").disabled = !ready;
  $("#bFromLine").disabled = !ready || !m.file;
  $("#bStep").disabled = !on || !m.file || (m && m.interp === "running");
  const paused = m && m.interp === "paused";
  $("#bStart").disabled = !m || !(paused || (ready && m.file));
  $("#bHold").disabled = !m || m.interp !== "running";
  $("#bStop").disabled = !m;
  $("#bMdi").disabled = !ready;
  if (!m) { $("#pFile").textContent = "Řízení neběží"; return; }
  $("#pFile").textContent = m.file || "Žádný program";
  const line = idle ? 0 : m.motion_line || m.current_line, total = S.programLines.length;
  $("#pBar").style.width = total ? Math.min(100, (100 * line) / total) + "%" : "0";
  $("#pLine").textContent = total ? (line ? line + " / " + total : total + " řádků") : "";
  if (!idle && !S.runStart) S.runStart = Date.now();
  if (idle) S.runStart = null;
  $("#pTime").textContent = S.runStart ? new Date(Date.now() - S.runStart).toISOString().substr(11, 8) : "";
  if (line !== lastHl) {
    const box = $("#gcode");
    if (lastHl > 0 && box.children[lastHl - 1]) box.children[lastHl - 1].classList.remove("cur");
    lastHl = line;
    const row = line > 0 ? box.children[line - 1] : null;
    if (row) { row.classList.add("cur"); box.scrollTop = row.offsetTop - box.offsetTop - box.clientHeight / 2; }   // jen seznam, ne celá stránka
  }
  sync("oFeed", m.feed_override, m.max_feed_override);
  sync("oRapid", m.rapid_override, 1);
  sync("oSpindle", m.spindle.override, m.max_spindle_override);
}
const drag = {};
function sync(id, v, max) {
  const el = $("#" + id);
  el.max = Math.round(max * 100);
  if (!drag[id]) el.value = Math.round(v * 100);
  $("#" + id + "Out").textContent = el.value + " %";
}
[["oFeed", "feed_override"], ["oRapid", "rapid_override"], ["oSpindle", "spindle_override"]].forEach(([id, cmd]) => {
  const el = $("#" + id);
  el.addEventListener("input", () => { drag[id] = true; $("#" + id + "Out").textContent = el.value + " %"; });
  el.addEventListener("change", () => { api(cmd, { value: el.value / 100 }); setTimeout(() => (drag[id] = false), 500); });
});
$$("[data-rt]").forEach((b) => b.addEventListener("click", () => {
  $$("[data-rt]").forEach((x) => x.classList.toggle("on", x === b));
  $("#rt-gcode").hidden = b.dataset.rt !== "gcode"; $("#rt-ovr").hidden = b.dataset.rt !== "ovr";
}));
$$("[data-sp]").forEach((b) => b.addEventListener("click", () => api("spindle", { dir: b.dataset.sp, rpm: S.rpm })));
$("#bRpm").addEventListener("click", () => askValue("Otáčky vřetena", "Použijí se pro tlačítka Vřeteno vlevo/vpravo.", S.rpm, (v) => {
  S.rpm = Math.max(0, Math.round(parseFloat(v)) || 0);
  try { localStorage.setItem("rpm", S.rpm); } catch (e) {}
  render();
}));
try { S.rpm = +localStorage.getItem("rpm") || 12000; } catch (e) {}
$("#bCool").addEventListener("click", () => api("coolant", { on: !(S.m && S.m.flood) }));
$("#bOrigin").addEventListener("click", () => api("goto_origin"));
$("#bFromLine").addEventListener("click", () => askValue("Spustit od řádku", "Program se spustí od zadaného řádku. Zkontroluj polohu nástroje a otáčky vřetena.", "", (v) => api("run", { line: Math.max(0, parseInt(v, 10) - 1) })));
$("#bStep").addEventListener("click", () => api("step"));
$("#bStart").addEventListener("click", () => api(S.m && S.m.interp === "paused" ? "resume" : "run"));
$("#bHold").addEventListener("click", () => api("pause"));
$("#bStop").addEventListener("click", () => api("stop"));
$("#bMdi").addEventListener("click", () => { const f = $("#mdiForm"); f.hidden = !f.hidden; if (!f.hidden) $("#mdiInput").focus(); });
$("#mdiForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const t = $("#mdiInput").value.trim().toUpperCase();
  if (t && await api("mdi", { text: t })) { $("#mdiInput").value = ""; S.mdiHist = [t, ...S.mdiHist.filter((x) => x !== t)].slice(0, 20); }
});
$("#mdiInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" && S.mdiHist.length) { const i = (S.mdiHist.indexOf(e.target.value) + 1) % S.mdiHist.length; e.target.value = S.mdiHist[i]; e.preventDefault(); }
});

/* ================================================================ F3 Ruční posuv */

function renderJog() {
  const m = S.m, on = m && m.state === "on", idle = m && m.interp === "idle";
  $$(".mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.jogMode));
  $$(".stepb").forEach((b) => { b.classList.toggle("on", +b.dataset.inc === S.inc); b.disabled = S.jogMode !== "step"; });
  $$("#ctx-jog .jog").forEach((b) => (b.disabled = !on || !idle));
  const rot = m ? m.dro.filter((a) => a.index > 2) : [];
  const pr = $("#padRot"), k = rot.map((a) => a.axis).join("");
  if (pr.dataset.k !== k) {
    pr.dataset.k = k;
    pr.innerHTML = rot.map((a) => `<button class="jog" data-axis="${a.index}" data-dir="-1">${a.axis}−</button><button class="jog" data-axis="${a.index}" data-dir="1">${a.axis}+</button>`).join("");
    bindJog(pr);
  }
  const v = m ? (+$("#jogSpeed").value / 100) * m.max_jog_velocity : 0;
  $("#jogSpeedOut").textContent = Math.round(v * 60) + " mm/min";
  const bp = $("#bPower");
  bp.disabled = !m;
  bp.innerHTML = !m ? "ZAPNOUT<small>stroj</small>" : m.state === "estop" ? "RESET<small>E-stop</small>" : m.state === "on" ? "VYPNOUT<small>stroj</small>" : "ZAPNOUT<small>stroj</small>";
  bp.className = "k " + (m && m.state === "off" ? "go" : "");
  $("#bHome").disabled = !on || !idle;
}
$$(".mode").forEach((b) => b.addEventListener("click", () => { S.jogMode = b.dataset.mode; render(); }));
$$(".stepb").forEach((b) => b.addEventListener("click", () => { S.inc = +b.dataset.inc; render(); }));
$("#jogSpeed").addEventListener("input", () => S.st && render());
$("#bPower").addEventListener("click", () => {
  const m = S.m; if (!m) return;
  api(m.state === "estop" ? "estop_reset" : m.state === "on" ? "machine_off" : "machine_on");
});
holdButton($("#bHome"), 1500, () => api("home_all"));

function holdButton(btn, ms, fn) {
  let t0 = 0, raf = 0;
  const bar = $("i", btn);
  const tick = () => {
    const p = Math.min(1, (Date.now() - t0) / ms);
    bar.style.width = p * 100 + "%";
    if (p >= 1) { cancel(); fn(); } else raf = requestAnimationFrame(tick);
  };
  const cancel = () => { cancelAnimationFrame(raf); raf = 0; bar.style.width = "0"; };
  btn.addEventListener("pointerdown", (e) => { if (btn.disabled) return; e.preventDefault(); t0 = Date.now(); tick(); });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, cancel));
}

function startJog(btn) {
  if (btn.disabled || !S.m) return;
  const axis = +btn.dataset.axis, dir = +btn.dataset.dir;
  const velocity = (+$("#jogSpeed").value / 100) * S.m.max_jog_velocity;
  if (S.jogMode === "step") {
    api("jog_start", { axis, dir, velocity, increment: S.inc });
    btn.classList.add("active"); setTimeout(() => btn.classList.remove("active"), 150);
    return;
  }
  stopJog(false);
  S.jog = btn; btn.classList.add("active");
  api("jog_start", { axis, dir, velocity, increment: 0 });
  S.jogTimer = setInterval(() => post("/api/cmd", { cmd: "jog_keep" }).catch(() => {}), 150);   // deadman
}
function stopJog(send = true) {
  if (S.jogTimer) { clearInterval(S.jogTimer); S.jogTimer = null; }
  if (S.jog) { S.jog.classList.remove("active"); S.jog = null; if (send) api("jog_stop"); }
}
function bindJog(root) {
  $$(".jog", root).forEach((b) => {
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); startJog(b); });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => b.addEventListener(ev, () => { if (S.jog === b) stopJog(); }));
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}
bindJog($("#ctx-jog .pad"));
window.addEventListener("blur", () => { stopJog(); stopMotor(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) { stopJog(); stopMotor(); } });

/* ================================================================ F4 Nástroje a offsety */

async function loadTools() {
  try { S.tools = (await get("/api/tools")).tools; } catch (e) { toast(e.message); }
  renderTools();
  if (S.m) { try { S.offsets = await get("/api/offsets"); } catch (e) { S.offsets = null; } } else S.offsets = null;
  renderOffsets();
}
function renderTools() {
  const cur = S.m ? S.m.tool : -1;
  $("#toolBody").innerHTML = S.tools.map((t, i) => `<tr class="${t.t === cur ? "sel" : ""}">
    <td style="width:110px"><input class="inp n" type="number" min="1" data-t="${i}" data-k="t" value="${t.t}"></td>
    <td><input class="inp" data-t="${i}" data-k="comment" value="${esc(t.comment)}" placeholder="např. fréza 6 mm"></td>
    <td style="width:150px"><input class="inp n" type="number" step="0.001" data-t="${i}" data-k="z" value="${t.z}"></td>
    <td style="width:150px"><input class="inp n" type="number" step="0.001" data-t="${i}" data-k="d" value="${t.d}"></td>
    <td style="width:60px"><button class="btn sm stop" data-tdel="${i}">✕</button></td></tr>`).join("") ||
    '<tr><td colspan="5" style="color:var(--muted)">Žádné nástroje. Přidej první tlačítkem nahoře.</td></tr>';
}
$("#toolBody").addEventListener("input", (e) => {
  const el = e.target.closest("[data-t]"); if (!el) return;
  const t = S.tools[+el.dataset.t], k = el.dataset.k;
  t[k] = k === "comment" ? el.value : parseFloat(el.value) || 0;
});
$("#toolBody").addEventListener("click", (e) => { const b = e.target.closest("[data-tdel]"); if (b) { S.tools.splice(+b.dataset.tdel, 1); renderTools(); } });
$("#tAdd").addEventListener("click", () => { const n = Math.max(0, ...S.tools.map((t) => t.t)) + 1; S.tools.push({ t: n, p: n, z: 0, d: 6, comment: "" }); renderTools(); });
$("#tSave").addEventListener("click", async () => { try { await post("/api/tools", { tools: S.tools }); toast("Tabulka nástrojů uložena.", true); loadTools(); } catch (e) { toast(e.message); } });
$("#tChange").addEventListener("click", () => { const n = +$("#tNum").value; if (n > 0) api("tool_change", { tool: n }); });
function renderOffsets() {
  const o = S.offsets;
  if (!o) {
    $("#offHead").innerHTML = "<tr><th>Pracovní offset</th></tr>";
    $("#offBody").innerHTML = '<tr><td style="color:var(--muted)">Offsety se zobrazí, když běží řízení.</td></tr>';
    return;
  }
  $("#offHead").innerHTML = `<tr><th>Pracovní offset</th>${o.axes.map((a) => `<th class="r">${a}</th>`).join("")}<th></th></tr>`;
  $("#offBody").innerHTML = o.rows.map((r) => `<tr class="${r.active ? "sel" : ""}"><td><b>${r.name}</b>${r.active ? " · aktivní" : ""}</td>
    ${r.values.map((v, i) => `<td class="r" style="cursor:pointer" data-off="${r.index}" data-ai="${i}">${Number(v).toFixed(4)}</td>`).join("")}
    <td class="r"><button class="btn sm" data-wcs="${r.index}" ${r.active ? "disabled" : ""}>Aktivovat</button></td></tr>`).join("");
}
$("#offBody").addEventListener("click", (e) => {
  const c = e.target.closest("[data-off]"), w = e.target.closest("[data-wcs]");
  if (w) api("select_wcs", { index: +w.dataset.wcs }).then(() => setTimeout(loadTools, 300));
  if (c) {
    const ax = S.offsets.axes[+c.dataset.ai], idx = "XYZABC".indexOf(ax);
    askValue(`${WCS[+c.dataset.off - 1]} – offset ${ax}`, "Strojní souřadnice nuly obrobku.", c.textContent,
             (v) => api("set_offset", { index: +c.dataset.off, axis: idx, value: parseFloat(v) }).then(() => setTimeout(loadTools, 300)));
  }
});

/* ================================================================ F5 Průvodci */

function wizParams() {
  const def = Wizards.DEFS[S.wiz], vals = S.wizVals[S.wiz] || {}, p = {};
  def.fields.forEach(([k, , , d]) => (p[k] = vals[k] ?? d));
  return p;
}
function renderWizard() {
  const def = Wizards.DEFS[S.wiz], p = wizParams();
  $$("#wizTabs button").forEach((b) => b.classList.toggle("on", b.dataset.w === S.wiz));
  $("#wizForm").innerHTML = def.fields.map(([k, label, unit]) => `<div class="f"><label>${esc(label)}${unit ? " [" + unit + "]" : ""}</label>
    <input class="inp n" type="number" step="any" data-wk="${k}" value="${p[k]}"></div>`).join("");
  $("#wizNote").textContent = def.note;
}
$$("#wizTabs button").forEach((b) => b.addEventListener("click", () => { S.wiz = b.dataset.w; renderWizard(); wizGenerate(true); }));
$("#wizForm").addEventListener("input", (e) => {
  const el = e.target.closest("[data-wk]"); if (!el) return;
  (S.wizVals[S.wiz] = S.wizVals[S.wiz] || {})[el.dataset.wk] = parseFloat(el.value) || 0;
});
function wizGenerate(quiet) {
  try { S.wizText = Wizards.DEFS[S.wiz].gen(wizParams()); updateViewport(); return true; }
  catch (e) { if (!quiet) toast(e.message); S.wizText = ""; updateViewport(); return false; }
}
$("#wizPreview").addEventListener("click", () => wizGenerate());
$("#wizSave").addEventListener("click", async () => {
  if (!wizGenerate()) return;
  const name = Wizards.fileName(S.wiz, wizParams());
  try {
    await post("/api/files/upload?name=" + encodeURIComponent(name), new Blob([S.wizText], { type: "text/plain" }), true);
    if (S.m) { await post("/api/files/open", { name }); toast("Uloženo a načteno: " + name, true); showScreen("run"); }
    else toast("Uloženo: " + name + " (řízení neběží, načti později v F6).", true);
  } catch (e) { toast(e.message); }
});

/* ================================================================ F6 Soubory */

async function loadFiles() {
  try {
    S.files = (await get("/api/files")).files;
    $("#files").innerHTML = S.files.length ? S.files.map((f) => `<button class="row ${f.name === S.sel ? "sel" : ""}" data-file="${esc(f.name)}">
      <span>${esc(f.name)}</span><span class="m">${(f.size / 1024).toFixed(1)} kB · ${new Date(f.mtime * 1000).toLocaleDateString("cs-CZ")}</span></button>`).join("")
      : '<div class="row" style="color:var(--muted)">Žádné programy. Nahraj soubor z tabletu.</div>';
  } catch (e) { toast(e.message); }
  ["#fLoad", "#fEdit", "#fDel"].forEach((s) => ($(s).disabled = !S.sel));
}
$("#files").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-file]"); if (!b) return;
  S.sel = b.dataset.file;
  $$("#files .row").forEach((x) => x.classList.toggle("sel", x === b));
  ["#fLoad", "#fEdit", "#fDel"].forEach((s) => ($(s).disabled = false));
  try { S.selText = (await get("/api/file?name=" + encodeURIComponent(S.sel))).text; } catch (err) { S.selText = ""; toast(err.message); }
  updateViewport();
});
$("#fLoad").addEventListener("click", async () => {
  try { await post("/api/files/open", { name: S.sel }); toast("Program načten.", true); showScreen("run"); } catch (e) { toast(e.message); }
});
$("#fDel").addEventListener("click", async () => {
  if (!S.sel || !confirm("Smazat " + S.sel + "?")) return;
  try { await post("/api/files/delete", { name: S.sel }); S.sel = null; S.selText = ""; updateViewport(); loadFiles(); } catch (e) { toast(e.message); }
});
$("#fUpload").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    await post("/api/files/upload?name=" + encodeURIComponent(f.name), f, true);
    toast("Nahráno: " + f.name, true); S.sel = f.name; await loadFiles();
    const row = $$("#files [data-file]").find((r) => r.dataset.file === f.name); if (row) row.click();
  } catch (err) { toast(err.message); }
});
$("#fEdit").addEventListener("click", () => {
  $("#textTitle").textContent = S.sel; $("#textArea").value = S.selText; $("#textSave").hidden = false; $("#textModal").hidden = false;
});
$("#textSave").addEventListener("click", async () => {
  try {
    await post("/api/files/upload?name=" + encodeURIComponent(S.sel), new Blob([$("#textArea").value], { type: "text/plain" }), true);
    S.selText = $("#textArea").value; $("#textModal").hidden = true; updateViewport(); toast("Uloženo.", true);
    if (S.m && S.m.file === S.sel) post("/api/files/open", { name: S.sel }).catch(() => {});
  } catch (e) { toast(e.message); }
});
$("#textClose").addEventListener("click", () => ($("#textModal").hidden = true));

/* ================================================================ úlohy na pozadí */

async function startJob(url, body, raw) {
  try { watchJob((await post(url, body, raw)).job); } catch (e) { toast(e.message); }
}
function watchJob(id) {
  $("#jobModal").hidden = false; $("#jobLog").textContent = "…"; $("#jobState").textContent = "";
  const tick = async () => {
    try {
      const j = (await get("/api/job?id=" + id)).job; if (!j) return;
      $("#jobTitle").textContent = j.title;
      $("#jobLog").textContent = j.log.join("\n") || "…";
      $("#jobLog").scrollTop = 1e9;
      $("#jobState").textContent = j.running ? "Probíhá…" : j.ok ? "Hotovo" : "Chyba";
      $("#jobState").style.color = j.running ? "var(--warn)" : j.ok ? "var(--ok)" : "var(--bad)";
      if (j.running) setTimeout(tick, 500); else if (S.screen === "setup") loadSetup(true);
    } catch (e) { setTimeout(tick, 1000); }
  };
  tick();
}
$("#jobClose").addEventListener("click", () => ($("#jobModal").hidden = true));

/* ================================================================ F1 Nastavení */

const AX = "XYZABC";
function menuItems() {
  const axes = S.draft ? S.draft.axes.filter((a) => a.enabled) : [];
  return [["general", "Obecné"], ...axes.map((a, i) => ["axis" + i, "Osa " + a.letter]), ["spindle", "Vřeteno"], ["io", "Vstupy a výstupy"],
    ["runtime", "Řízení a deska"], ["system", "Systém a latence"], ["updates", "Aktualizace"], ["history", "Zálohy"], ["account", "Heslo správce"],
    ["save", "Uložit a použít"]];
}
async function loadSetup(force) {
  if (S.draft && !force) return renderSetup();
  try {
    S.setup = await get("/api/setup");
    S.saved = clone(S.setup.machine);
    S.draft = clone(S.setup.machine);
  } catch (e) { toast(e.message); }
  renderSetup();
}
function dirty() { return S.saved && S.draft && JSON.stringify(S.saved) !== JSON.stringify(S.draft); }
function renderSetup() {
  if (!S.draft) return;
  const items = menuItems();
  if (!items.some(([k]) => k === S.section)) S.section = "general";
  $("#setupMenu").innerHTML = "<h3>Nastavení stroje</h3>" + items.map(([k, l]) => `<button data-sec="${k}" class="${k === S.section ? "on" : ""} ${k === "save" && dirty() ? "dirty" : ""}">${l}</button>`).join("") +
    `<div class="ver">OpenCNC Web ${esc(S.auth ? S.auth.version : "")}${S.auth && S.auth.demo ? " · simulace" : ""}<br>Deska: EC300 (Remora)<br>LinuxCNC 2.9</div>`;
  renderSection();
  manageDiag();
}
$("#setupMenu").addEventListener("click", (e) => { const b = e.target.closest("[data-sec]"); if (b) { stopMotor(); S.section = b.dataset.sec; renderSetup(); } });

function lockBar() {
  if (isAdmin()) return dirty() && S.section !== "save" ? `<div class="savebar note warn"><span class="grow">Máš neuložené změny.</span><button class="btn acc sm" data-goto="save">Zkontrolovat a uložit</button><button class="btn sm" data-revert>Zahodit</button></div>` : "";
  return `<div class="lockbar"><span class="grow">${S.auth && S.auth.needs_setup ? "Heslo správce zatím není nastavené. Nastav ho, aby šlo měnit nastavení." : "Nastavení je jen pro čtení. Změny může dělat správce."}</span>
    <button class="btn acc" data-unlock>${S.auth && S.auth.needs_setup ? "Nastavit heslo" : "Odemknout"}</button></div>`;
}
const dis = () => (isAdmin() ? "" : "disabled");
function getP(p) { return p.split(".").reduce((a, k) => (a == null ? a : a[k]), S.draft); }
function setP(p, v) { const ks = p.split("."), last = ks.pop(); ks.reduce((a, k) => a[k], S.draft)[last] = v; }
function fNum(path, label, unit, hint) {
  return `<div class="f"><label>${label}${unit ? " [" + unit + "]" : ""}</label><input class="inp n" type="number" step="any" data-p="${path}" data-ty="num" value="${getP(path) ?? ""}" ${dis()}>${hint ? `<small>${hint}</small>` : ""}</div>`;
}
function fChk(path, label) { return `<label class="chk"><input type="checkbox" data-p="${path}" data-ty="bool" ${getP(path) ? "checked" : ""} ${dis()}> ${label}</label>`; }

function renderSection() {
  const c = $("#setupContent"), sec = S.section;
  let h = lockBar();
  if (sec === "general") h += secGeneral();
  else if (sec.startsWith("axis")) h += secAxis(+sec.slice(4));
  else if (sec === "spindle") h += secSpindle();
  else if (sec === "io") h += secIO();
  else if (sec === "runtime") h += secRuntime();
  else if (sec === "system") h += secSystem();
  else if (sec === "updates") h += secUpdates();
  else if (sec === "history") h += secHistory();
  else if (sec === "account") h += secAccount();
  else if (sec === "save") h += secSave();
  c.innerHTML = h;
  if (sec.startsWith("axis")) updateCalc();
  if (sec === "save") runValidation();
  if (sec === "runtime") renderRuntimeLive();
  if (S.diag) applyDiag();
}
$("#setupContent").addEventListener("input", (e) => {
  if (e.target.id === "motorHz") { S.motor.hz = +e.target.value; $("#motorHzOut").textContent = S.motor.hz + " Hz"; return; }
  const el = e.target.closest("[data-p]"); if (!el) return;
  setP(el.dataset.p, el.dataset.ty === "bool" ? el.checked : el.dataset.ty === "num" ? (el.value === "" ? 0 : parseFloat(el.value)) : el.value);
  if (S.section.startsWith("axis")) updateCalc();
  $$("#setupMenu [data-sec=save]").forEach((b) => b.classList.toggle("dirty", dirty()));
});

function secGeneral() {
  const n = S.draft.axes.filter((a) => a.enabled).length;
  return `<h2>Obecné</h2>${S.setup && !S.setup.configured ? '<div class="note warn">Stroj zatím není nastavený. Projdi sekce v levém menu shora dolů, otestuj spínače a motory a nakonec dej Uložit a použít.</div>' : ""}
    <div class="sect"><h3>Stroj</h3><div class="form">
    <div class="f"><label>Název stroje</label><input class="inp" data-p="machine_name" value="${esc(S.draft.machine_name)}" ${dis()}></div>
    <div class="f"><label>Řídicí deska</label><input class="inp" value="EC300 · Remora · ${esc(S.draft.board_ip)}" disabled></div></div>
    <div class="f"><label>Počet os</label><div class="flex">${[1, 2, 3, 4, 5, 6].map((k) => `<button class="btn ${k === n ? "acc" : ""}" data-axn="${k}" ${dis()}>${k} · ${AX.slice(0, k)}</button>`).join("")}</div>
      <small>Osy A–C jsou otočné. Šestá osa (C) potřebuje firmware s opravou směrového pinu P1_19.</small></div>
    ${fChk("require_homing", "Před MDI a spuštěním programu vyžadovat referování (doporučeno)")}</div>`;
}
$("#setupContent").addEventListener("click", async (e) => {
  const t = e.target;
  if (t.closest("[data-unlock]")) return openUnlock();
  if (t.closest("[data-revert]")) { S.draft = clone(S.saved); return renderSetup(); }
  const go = t.closest("[data-goto]"); if (go) { S.section = go.dataset.goto; return renderSetup(); }
  const ax = t.closest("[data-axn]");
  if (ax) {
    const n = +ax.dataset.axn, axes = S.draft.axes;
    while (axes.length < n) { const a = clone(axes[axes.length - 1]); a.letter = AX[axes.length]; axes.push(a); }
    axes.forEach((a, i) => { a.enabled = i < n; a.letter = AX[i]; });
    S.draft.axes = axes.slice(0, n);
    return renderSetup();
  }
  const out = t.closest("[data-outbit]");
  if (out) { try { await post("/api/diag/output", { bit: +out.dataset.outbit, value: !out.classList.contains("hi") }); pollDiag(); } catch (err) { toast(err.message); } }
  const g = t.closest("[data-gen]");
  if (g && S.validation) {
    let txt = S.validation.files[g.dataset.gen];
    if (g.dataset.gen.endsWith(".json")) txt = JSON.stringify(JSON.parse(txt), null, 2);
    $("#textTitle").textContent = g.dataset.gen; $("#textArea").value = txt; $("#textSave").hidden = true; $("#textModal").hidden = false;
  }
  if (t.closest("[data-apply]")) startJob("/api/setup/apply", { machine: S.draft });
  const rb = t.closest("[data-rollback]");
  if (rb && confirm("Obnovit konfiguraci " + rb.dataset.rollback + "? Aktuální se nejdřív zazálohuje.")) startJob("/api/setup/rollback", { id: rb.dataset.rollback });
  const rt = t.closest("[data-rt-act]");
  if (rt) {
    const act = rt.dataset.rtAct;
    if (act === "stop" && !confirm("Zastavit řízení? Stroj se zastaví.")) return;
    if (act === "start" && S.st.runtime.commissioning) {
      if (!isAdmin()) return openUnlock();
      if (!$$("[data-safety]").every((x) => x.checked)) return toast("Nejdřív potvrď všechny body kontroly bezpečnosti.");
      return post("/api/runtime", { action: "start", confirm_safety: true }).catch((err) => toast(err.message));
    }
    post("/api/runtime", { action: act }).catch((err) => toast(err.message));
  }
  const job = t.closest("[data-job]"); if (job) startJob("/api/jobs/" + job.dataset.job, job.dataset.secs ? { seconds: +job.dataset.secs } : {});
  const pw = t.closest("[data-power]");
  if (pw && confirm(pw.dataset.power === "reboot" ? "Restartovat Raspberry Pi?" : "Vypnout Raspberry Pi?")) post("/api/system/power", { action: pw.dataset.power }).catch((err) => toast(err.message));
  if (t.closest("[data-pwsave]")) {
    const a = $("#pwNew").value, b = $("#pwNew2").value;
    if (a.length < 4) return toast("Heslo musí mít alespoň 4 znaky.");
    if (a !== b) return toast("Hesla se neshodují.");
    try { await post("/api/auth/passwords", { admin: a }); toast("Heslo změněno, odemkni znovu.", true); await refreshAuth(); } catch (err) { toast(err.message); }
  }
});
$("#setupContent").addEventListener("change", async (e) => {
  const fi = e.target.closest("[data-infn]"), inv = e.target.closest("[data-inv]"), of = e.target.closest("[data-outfn]");
  if (fi) { const b = fi.dataset.infn; if (fi.value) S.draft.inputs[b] = { function: fi.value, invert: !!(S.draft.inputs[b] || {}).invert }; else delete S.draft.inputs[b]; renderSection(); }
  if (inv) { const b = inv.dataset.inv; if (S.draft.inputs[b]) S.draft.inputs[b].invert = inv.checked; else { inv.checked = false; toast("Nejdřív vyber funkci vstupu."); } }
  if (of) { if (of.value) S.draft.outputs[of.dataset.outfn] = of.value; else delete S.draft.outputs[of.dataset.outfn]; }
  if (e.target.id === "pwmTest") post("/api/diag/pwm", { percent: +e.target.value }).catch((err) => toast(err.message));
  if (e.target.id === "fwFile") {
    const f = e.target.files[0]; e.target.value = "";
    if (f && confirm("Nahrát firmware " + f.name + " do EC300 přes SWD?")) startJob("/api/jobs/flash", f, true);
  }
  $$("#setupMenu [data-sec=save]").forEach((b) => b.classList.toggle("dirty", dirty()));
});

function secAxis(i) {
  const a = S.draft.axes[i], p = `axes.${i}.`, rot = "ABC".includes(a.letter), u = rot ? "°" : "mm";
  const stopped = S.st && ["stopped", "failed"].includes(S.st.runtime.state);
  return `<h2>Osa ${a.letter} <span class="calc" id="calc"></span></h2>
    <div class="sect"><h3>Motor a převod</h3><div class="form">
      ${fNum(p + "steps_per_rev", "Kroků na otáčku motoru", "", "běžně 200 (1,8°)")}${fNum(p + "microsteps", "Mikrokrokování", "×", "nastavení driveru")}
      ${fNum(p + "pitch", rot ? "Stupňů na otáčku" : "Stoupání šroubu", rot ? "°/ot" : "mm/ot")}${fNum(p + "gear", "Převod motor : šroub", "", "1 = přímo")}
      <div class="f"><label>Směr</label>${fChk(p + "invert_dir", "Obrátit směr osy")}</div></div></div>
    <div class="sect"><h3>Rychlost a dráha</h3><div class="form">
      ${fNum(p + "max_vel", "Max. rychlost", u + "/min")}${fNum(p + "accel", "Zrychlení", u + "/s²")}
      ${fNum(p + "min_limit", "Softwarový limit min.", u)}${fNum(p + "max_limit", "Softwarový limit max.", u)}</div></div>
    <div class="sect"><h3>Referování</h3><div class="form">
      ${fNum(p + "home_search_vel", "Rychlost hledání", u + "/min", "znaménko = směr (− k minimu)")}${fNum(p + "home_latch_vel", "Pomalý dojezd", u + "/min", "stejné znaménko")}
      ${fNum(p + "home_offset", "Poloha spínače", u, "souřadnice, kde spínač sepne")}${fNum(p + "home_position", "Poloha po referování", u)}
      ${fNum(p + "home_sequence", "Pořadí", "", "0 = první (obvykle Z)")}</div>
      <small style="color:var(--muted)">Referenční spínač přiřaď v sekci Vstupy a výstupy. Bez spínače se jako reference vezme aktuální poloha.</small></div>
    <div class="sect"><h3>Časování STEP/DIR</h3><div class="form">
      ${fNum(p + "step_len", "Délka pulzu", "µs")}${fNum(p + "step_space", "Mezera mezi pulzy", "µs")}${fNum(p + "dir_setup", "DIR před krokem", "µs")}${fNum(p + "dir_hold", "DIR po kroku", "µs")}</div>
      <small style="color:var(--muted)">Z datasheetu driveru, např. DM542: pulz ≥ 2,5 µs, DIR ≥ 5 µs.</small></div>
    <div class="sect"><h3>Test motoru</h3>
      ${!isAdmin() ? '<div class="note">Test motoru může spustit jen správce.</div>' : !stopped ? '<div class="note warn">Test motoru jde jen při zastaveném řízení (Řízení a deska → Zastavit).</div>' : `
      <div class="note warn">Motor se točí jen při držení tlačítka a deska ho sama zastaví do 5 ms po výpadku spojení. Hardwarový E-stop musí odpojit drivery nezávisle.
        Test používá konfiguraci uloženou v desce: po změně kroků nebo časování nejdřív ulož.</div>
      <div class="ovr" style="grid-template-columns:110px 1fr 90px"><label>Frekvence</label><input type="range" id="motorHz" min="100" max="5000" step="100" value="${S.motor.hz}"><output id="motorHzOut">${S.motor.hz} Hz</output></div>
      <div class="flex"><button class="jog grow" style="min-height:70px" data-motor="-1">◀ Vzad</button><button class="jog grow" style="min-height:70px" data-motor="1">Vpřed ▶</button></div>
      <dl class="kv"><dt>Kroky</dt><dd id="motorCount">0</dd><dt>Ujetá dráha podle nastavení</dt><dd id="motorDist">–</dd></dl>`}</div>`;
}
function axisScale(a) { return (a.steps_per_rev * a.microsteps * (a.gear || 1)) / a.pitch * (a.invert_dir ? -1 : 1); }
function updateCalc() {
  const el = $("#calc"); if (!el) return;
  const a = S.draft.axes[+S.section.slice(4)], sc = Math.abs(axisScale(a)), khz = (sc * a.max_vel) / 60000;
  const lim = Math.min(500, 1000 / Math.max(2, a.step_len + a.step_space));
  el.innerHTML = isFinite(sc) ? ` · <b>${sc.toFixed(2)}</b> kroků/mm · <b style="color:${khz > lim ? "var(--bad)" : khz > lim * 0.8 ? "var(--warn)" : "var(--ok)"}">${khz.toFixed(1)} kHz</b> z ${lim.toFixed(0)} kHz` : "";
}
$("#setupContent").addEventListener("pointerdown", (e) => {
  const b = e.target.closest("[data-motor]"); if (!b) return;
  e.preventDefault(); b.setPointerCapture(e.pointerId);
  stopMotor(); S.motor.joint = +S.section.slice(4); S.motor.dir = +b.dataset.motor; b.classList.add("active");
  const send = () => post("/api/diag/motor", { joint: S.motor.joint, freq: S.motor.dir * S.motor.hz }).catch((err) => { toast(err.message); stopMotor(); });
  send(); S.motor.timer = setInterval(send, 100);
});
["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => $("#setupContent").addEventListener(ev, (e) => { if (e.target.closest && e.target.closest("[data-motor]")) stopMotor(); }, true));
function stopMotor() {
  if (S.motor.timer) { clearInterval(S.motor.timer); S.motor.timer = null; }
  if (S.motor.dir) { S.motor.dir = 0; post("/api/diag/motor", { joint: S.motor.joint, freq: 0 }).catch(() => {}); }
  $$("[data-motor]").forEach((b) => b.classList.remove("active"));
}

function secSpindle() {
  return `<h2>Vřeteno</h2><div class="sect"><h3>Řízení otáček</h3><div class="form">
    ${fNum("spindle.max_rpm", "Max. otáčky (100 % PWM = 10 V)", "ot/min")}
    <div class="f"><label>Výstup</label>${fChk("spindle.pwm", "PWM výstup desky EC300 (0–10 V)")}</div></div>
    <small style="color:var(--muted)">Zapnutí a směr vřetena přiřaď na výstupy v sekci Vstupy a výstupy. Měnič nastav tak, aby 10 V odpovídalo maximálním otáčkám.</small></div>`;
}

function secIO() {
  const fns = S.setup.input_functions, ofns = S.setup.output_functions;
  const letters = S.draft.axes.filter((a) => a.enabled).map((a) => a.letter);
  const usable = Object.entries(fns).filter(([k]) => !/_([A-Z])$/.test(k) || letters.includes(k.slice(-1)));
  const canOut = isAdmin() && S.st && ["stopped", "failed"].includes(S.st.runtime.state);
  return `<h2>Vstupy a výstupy</h2>
    <div class="note">Sepni spínač na stroji a sleduj sloupec Stav. Pokud je vstup v klidu High, zaškrtni Obrátit. Výstupy jde při zastaveném řízení přepínat klepnutím na stav.</div>
    <div style="display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:14px;min-height:0">
    <div class="tbl"><table><thead><tr><th>Vstup</th><th>Funkce</th><th class="c">Obrátit</th><th class="c">Stav</th></tr></thead><tbody>
      ${S.setup.inputs.map((i) => { const cur = S.draft.inputs[i.bit] || {}; return `<tr><td><b>${i.terminal}</b></td>
        <td><select class="inp" data-infn="${i.bit}" ${dis()}><option value="">—</option>${usable.map(([k, v]) => `<option value="${k}" ${cur.function === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></td>
        <td class="c"><input type="checkbox" data-inv="${i.bit}" ${cur.invert ? "checked" : ""} ${dis()} style="width:22px;height:22px;accent-color:var(--accent)"></td>
        <td class="c"><span class="lvl" data-inlvl="${i.bit}">Low</span></td></tr>`; }).join("")}</tbody></table></div>
    <div style="display:grid;gap:14px;align-content:start">
    <div class="tbl"><table><thead><tr><th>Výstup</th><th>Funkce</th><th class="c">Stav</th></tr></thead><tbody>
      ${S.setup.outputs.map((o) => `<tr><td><b>${o.terminal}</b></td>
        <td><select class="inp" data-outfn="${o.bit}" ${dis()}><option value="">—</option>${Object.entries(ofns).map(([k, v]) => `<option value="${k}" ${S.draft.outputs[o.bit] === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></td>
        <td class="c"><span class="lvl ${canOut ? "click" : ""}" data-outbit="${o.bit}" ${canOut ? "" : 'style="pointer-events:none"'}>Low</span></td></tr>`).join("")}</tbody></table></div>
    <div class="sect"><h3>Test PWM vřetena</h3>${canOut ? `<input type="range" id="pwmTest" min="0" max="100" value="0"><small style="color:var(--muted)">0–100 % = 0–10 V na výstupu pro měnič.</small>` : '<div class="note">Jen pro správce při zastaveném řízení.</div>'}</div>
    </div></div>`;
}

const SAFETY = ["Hardwarový E-stop odpojí napájení driverů (nebo STO) nezávisle na Raspberry Pi.",
  "Vstup E-stop a koncové spínače reagují ve Vstupech a výstupech.",
  "Osy se v testu motoru pohybují správným směrem a o správnou vzdálenost.",
  "Vřeteno je odpojené nebo zajištěné a v pracovním prostoru nikdo není."];
function secRuntime() {
  return `<h2>Řízení a deska</h2><div class="sect"><h3>Řízení (LinuxCNC)</h3><div id="rtLive"></div>
    <div class="flex"><button class="btn go" data-rt-act="start">Spustit</button><button class="btn" data-rt-act="restart" ${dis()}>Restartovat</button><button class="btn stop" data-rt-act="stop" ${dis()}>Zastavit</button></div>
    <div id="rtSafety"></div></div>
    <div class="sect"><h3>Deska EC300</h3><dl class="kv" id="boardKv"></dl></div>
    <div class="sect"><h3>Alarmy a zprávy</h3><div class="list" id="msgList" style="max-height:34vh"></div></div>`;
}
function renderRuntimeLive() {
  const rt = S.st && S.st.runtime; if (!rt || !$("#rtLive")) return;
  const names = { stopped: "zastavené", starting: "startuje", running: "běží", stopping: "zastavuje se", failed: "chyba" };
  $("#rtLive").innerHTML = `<dl class="kv"><dt>Stav</dt><dd>${names[rt.state] || rt.state}${rt.state === "running" ? " · " + Math.floor(rt.uptime / 60) + " min" : ""}</dd>
    <dt>Konfigurace</dt><dd>${rt.configured ? "uložená" : "chybí, projdi nastavení"}</dd><dt>Poslední funkční</dt><dd>${esc(rt.last_good || "–")}</dd></dl>
    ${rt.error ? `<div class="note bad">${esc(rt.error)}</div>` : ""}`;
  const sf = $("#rtSafety");
  if (rt.commissioning && !sf.dataset.on) {
    sf.dataset.on = "1";
    sf.innerHTML = `<div class="note warn" style="display:grid;gap:4px"><b>Nová konfigurace: před spuštěním potvrď kontrolu bezpečnosti</b>
      ${SAFETY.map((s, i) => `<label class="chk"><input type="checkbox" data-safety="${i}" ${dis()}> ${esc(s)}</label>`).join("")}</div>`;
  } else if (!rt.commissioning && sf.dataset.on) { sf.dataset.on = ""; sf.innerHTML = ""; }
  const b = S.st.board;
  $("#boardKv").innerHTML = `<dt>Spojení</dt><dd style="color:${b.ok ? "var(--ok)" : "var(--bad)"}">${b.ok ? "OK" : "neodpovídá"}</dd>
    ${b.rtt_ms != null ? `<dt>Odezva</dt><dd>${b.rtt_ms.toFixed(2)} ms</dd>` : ""}<dt>Adresa</dt><dd>10.10.10.10 (UDP 27181)</dd>
    <dt>Data</dt><dd>${["stopped", "failed"].includes(rt.state) ? "přímo z desky" : "přes LinuxCNC"}</dd>`;
  const list = S.messages.slice().reverse();
  $("#msgList").innerHTML = list.length ? list.map((x) => `<div class="row" style="border-left:3px solid ${x.kind === "error" ? "var(--bad)" : x.kind === "warn" ? "var(--warn)" : "var(--accent)"}">
    <span style="color:var(--muted);font-size:12px">${new Date(x.t * 1000).toLocaleTimeString("cs-CZ")}</span><span>${esc(x.text)}</span></div>`).join("")
    : '<div class="row" style="color:var(--muted)">Žádné zprávy.</div>';
}

function secSystem() {
  return `<h2>Systém a latence</h2><div class="sect"><h3>Raspberry Pi</h3><dl class="kv" id="sysKv"></dl></div>
    <div class="sect"><h3>Test latence real-time jádra</h3><div style="color:var(--muted);font-size:14px">cyclictest: do 50 µs výborné, do 100 µs v pořádku pro servo thread 1 ms.</div>
      <div class="flex"><button class="btn" data-job="latency" data-secs="30" ${dis()}>30 s</button><button class="btn" data-job="latency" data-secs="300" ${dis()}>5 minut</button></div></div>
    <div class="sect"><h3>Log LinuxCNC</h3><pre class="log" id="rtLog">${isAdmin() ? "…" : "Log vidí jen správce."}</pre></div>`;
}
function secUpdates() {
  return `<h2>Aktualizace</h2>
    <div class="sect"><h3>Systém a LinuxCNC</h3><div style="color:var(--muted)">Balíčky z repozitářů Debianu a LinuxCNC. Řízení musí stát.</div>
      <div class="flex"><button class="btn" data-job="check_updates" ${dis()}>Zkontrolovat</button><button class="btn acc" data-job="upgrade" ${dis()}>Aktualizovat</button></div></div>
    <div class="sect"><h3>Komponenta Remora pro LinuxCNC</h3><div style="color:var(--muted)">Po aktualizaci LinuxCNC ji je potřeba znovu přeložit.</div>
      <div class="flex"><button class="btn" data-job="halcomp" ${dis()}>Přeložit a nainstalovat</button></div></div>
    <div class="sect"><h3>Firmware EC300</h3><div style="color:var(--muted)">Přes Raspberry Pi Pico (debugprobe) připojené k USB Raspberry Pi. Soubor .bin pro RT1052.</div>
      <div class="flex"><label class="btn" for="fwFile" ${isAdmin() ? "" : 'style="pointer-events:none;opacity:.35"'}>Vybrat firmware a nahrát</label><input type="file" id="fwFile" accept=".bin" hidden></div></div>
    <div class="sect"><h3>Raspberry Pi</h3><div class="flex"><button class="btn" data-power="reboot" ${dis()}>Restartovat</button><button class="btn stop" data-power="poweroff" ${dis()}>Vypnout</button></div></div>`;
}
function secHistory() {
  const h = S.setup.history || [];
  return `<h2>Zálohy konfigurace</h2><div class="note">Před každým uložením se vytvoří záloha. Funkční = poslední, se kterou řízení běželo a deska odpovídala.</div>
    <div class="list">${h.length ? h.map((x) => `<div class="row"><b>${esc(x.id)}</b><span style="color:var(--muted)">${esc(x.reason)}</span>${x.good ? '<span style="color:var(--ok);font-weight:700">funkční</span>' : ""}
      <span class="m"><button class="btn sm" data-rollback="${esc(x.id)}" ${dis()}>Obnovit</button></span></div>`).join("") : '<div class="row" style="color:var(--muted)">Zatím žádné zálohy.</div>'}</div>`;
}
function secAccount() {
  return `<h2>Heslo správce</h2><div class="sect"><div style="color:var(--muted)">Heslo chrání jen nastavení stroje, testy a aktualizace. Ovládání stroje (F2–F6) heslo nevyžaduje.</div>
    ${isAdmin() ? `<div class="form"><div class="f"><label>Nové heslo</label><input class="inp" type="password" id="pwNew" autocomplete="new-password"></div>
      <div class="f"><label>Nové heslo znovu</label><input class="inp" type="password" id="pwNew2" autocomplete="new-password"></div></div>
      <div><button class="btn acc" data-pwsave>Změnit heslo</button></div>` : ""}</div>`;
}
function diffList(a, b, pre = "") {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const p = pre ? pre + "." + k : k, va = a ? a[k] : undefined, vb = b ? b[k] : undefined;
    if (va && vb && typeof va === "object" && typeof vb === "object") out.push(...diffList(va, vb, p));
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push([p, va, vb]);
  }
  return out;
}
function secSave() {
  const running = S.st && !["stopped", "failed"].includes(S.st.runtime.state);
  const diff = S.setup.configured ? diffList(S.saved, S.draft) : null;
  return `<h2>Uložit a použít</h2>
    <div class="sect"><h3>Kontrola</h3><div id="valOut" style="display:grid;gap:6px">Kontroluji…</div></div>
    <div class="sect"><h3>Změny proti uložené konfiguraci</h3>${diff === null ? '<div class="note">První nastavení stroje.</div>' : diff.length ?
      `<div class="list" style="max-height:28vh">${diff.map(([p, a, b]) => `<div class="row"><span>${esc(p)}</span><span class="m">${esc(JSON.stringify(a))} → ${esc(JSON.stringify(b))}</span></div>`).join("")}</div>` : '<div style="color:var(--muted)">Beze změn.</div>'}</div>
    <div class="sect"><h3>Uložení</h3>
      ${running ? '<div class="note warn">Řízení běží. Nastavení ovlivňující pohyb lze uložit jen při zastaveném řízení (Řízení a deska → Zastavit).</div>' : ""}
      <div style="color:var(--muted)">Uložení vytvoří zálohu, vygeneruje konfiguraci LinuxCNC a desky a nahraje ji do EC300. Pohyb se nepovolí, dokud správce nepotvrdí kontrolu bezpečnosti.</div>
      <div class="flex"><button class="btn acc" data-apply id="applyBtn" ${running || !isAdmin() ? "disabled" : ""}>Uložit a nahrát do EC300</button><span class="grow"></span><span id="genFiles" class="flex"></span></div></div>`;
}
async function runValidation() {
  try {
    if (!isAdmin()) { $("#valOut").innerHTML = '<div class="note">Kontrolu a uložení může spustit správce.</div>'; return; }
    const j = await post("/api/setup/validate", { machine: S.draft });
    S.validation = j;
    $("#valOut").innerHTML = [...j.errors.map((e) => `<div class="note bad">${esc(e)}</div>`), ...j.warnings.map((w) => `<div class="note warn">${esc(w)}</div>`),
      j.errors.length ? "" : '<div class="note ok">Nastavení je v pořádku.</div>',
      ...j.axes.filter((a, i) => S.draft.axes[i] && S.draft.axes[i].enabled).map((a) => `<div class="row"><b>Osa ${a.letter}</b><span class="m">${a.scale} kroků/mm · ${a.step_khz} kHz</span></div>`)].join("");
    $("#genFiles").innerHTML = Object.keys(j.files).map((f) => `<button class="btn sm" data-gen="${f}">${f}</button>`).join("");
    if (j.errors.length) $("#applyBtn").disabled = true;
  } catch (e) { $("#valOut").innerHTML = `<div class="note bad">${esc(e.message)}</div>`; }
}

/* ---------- živá diagnostika v nastavení ---------- */
function manageDiag() {
  const need = S.screen === "setup" && (["io", "system", "runtime"].includes(S.section) || S.section.startsWith("axis"));
  if (need && !S.diagTimer) { pollDiag(); S.diagTimer = setInterval(pollDiag, 400); }
  if (!need && S.diagTimer) { clearInterval(S.diagTimer); S.diagTimer = null; }
}
async function pollDiag() {
  try { S.diag = await get("/api/diag"); applyDiag(); } catch (e) { /* stav ukazuje hlavní dotazování */ }
}
function applyDiag() {
  const d = S.diag; if (!d || S.screen !== "setup") return;
  d.inputs.forEach((x) => { const el = $(`[data-inlvl="${x.bit}"]`); if (el) { el.textContent = x.on ? "High" : "Low"; el.classList.toggle("hi", x.on); } });
  d.outputs.forEach((x) => { const el = $(`[data-outbit="${x.bit}"]`); if (el) { el.textContent = x.on ? "High" : "Low"; el.classList.toggle("hi", x.on); } });
  if ($("#sysKv")) {
    const s = d.system || {};
    $("#sysKv").innerHTML = [["Model", s.model], ["Jádro", s.kernel], ["Real-time (PREEMPT_RT)", s.rt ? "ano" : "NE"], ["Teplota CPU", s.cpu_temp != null ? s.cpu_temp + " °C" : "–"],
      ["Zatížení", (s.load || []).map((x) => x.toFixed(2)).join(" ")], ["Paměť", s.mem_used_pct + " %"], ["Volné místo", s.disk_free_gb + " GB"], ["LinuxCNC", s.linuxcnc],
      ["Komponenta Remora", s.remora_component ? "nainstalovaná" : "CHYBÍ"], ["pyOCD", s.pyocd ? "ano" : "ne"], ...(s.interfaces || []).map((i) => [i.name, i.addr])]
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v ?? "–")}</dd>`).join("");
    if ($("#rtLog") && isAdmin()) $("#rtLog").textContent = d.log || "(prázdný)";
  }
  if ($("#motorCount")) {
    const j = +S.section.slice(4), c = (d.board.counts || [])[j] || 0, a = S.draft.axes[j];
    $("#motorCount").textContent = c;
    $("#motorDist").textContent = (c / axisScale(a)).toFixed(3) + ("ABC".includes(a.letter) ? " °" : " mm");
  }
}

/* ================================================================ start */

(async function init() {
  try { await refreshAuth(); } catch (e) { $("#offline").hidden = false; }
  showScreen((location.hash || "#run").slice(1));
  poll();
})();
