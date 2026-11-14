"""
CNC Web Manager: HTTP server pro tablet (jen standardní knihovna Pythonu).
"""

import json
import os
import re
import threading
import time
import traceback
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import configgen, system
from .auth import Auth
from .board import BoardError
from .machine import UserError

HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND = os.path.join(os.path.dirname(os.path.dirname(HERE)), "frontend")
STATIC = {"/": ("index.html", "text/html; charset=utf-8"),
          "/app.js": ("app.js", "application/javascript; charset=utf-8"),
          "/app.css": ("app.css", "text/css; charset=utf-8"),
          "/toolpath.js": ("toolpath.js", "application/javascript; charset=utf-8")}
MAX_UPLOAD = 30 * 1024 * 1024
PROGRAM_EXT = (".ngc", ".nc", ".tap", ".gcode", ".txt")
SAFE_NAME = re.compile(r"^[A-Za-z0-9._\- ]{1,120}$")
VERSION = "0.1.0"


class App:
    """Sdílený stav aplikace."""

    def __init__(self, runtime, board, auth, demo):
        self.runtime = runtime
        self.board = board
        self.auth = auth
        self.demo = demo
        self.jobs = system.Jobs()
        self.lock = threading.Lock()
        self.messages = []
        self.msg_seq = 0
        self.sysinfo = {}
        self.sysinfo_t = 0
        self.board_state = {"ok": False}
        threading.Thread(target=self._background, daemon=True).start()

    def message(self, kind, text):
        with self.lock:
            if self.messages and self.messages[-1]["text"] == text and time.time() - self.messages[-1]["t"] < 5:
                return
            self.msg_seq += 1
            self.messages.append({"id": self.msg_seq, "t": time.time(), "kind": kind, "text": text})
            del self.messages[:-100]

    def _background(self):
        was_ok = None
        while True:
            try:
                if self.runtime.status()["state"] in ("stopped", "failed"):
                    st = self.board.session_state() if self.board.session else self.board.probe(1)
                else:
                    m = self.runtime.get_machine()
                    ok = bool(m.hal_value("remora.status")) if m else False
                    if self.demo:
                        ok = True
                    st = {"ok": ok, "rtt_ms": None,
                          "inputs": m.hal_inputs(len(configgen.EC300_INPUTS)) if m else 0}
                self.board_state = st
                if was_ok is not None and was_ok != st["ok"]:
                    self.message("info" if st["ok"] else "error",
                                 "Deska EC300 odpovídá." if st["ok"] else "Deska EC300 neodpovídá (Ethernet, napájení?).")
                was_ok = st["ok"]
            except Exception:
                traceback.print_exc()
            time.sleep(0.25 if self.board.session else 1.0)

    def get_sysinfo(self):
        if time.time() - self.sysinfo_t > 10:
            self.sysinfo = system.info(self.demo)
            self.sysinfo_t = time.time()
        return self.sysinfo

    def nc_dir(self):
        return os.path.join(self.runtime.machine_dir, "nc_files")

    def safe_program_path(self, name):
        name = os.path.basename(name or "")
        if not SAFE_NAME.match(name) or not name.lower().endswith(PROGRAM_EXT):
            raise UserError("Neplatný název souboru (povolené přípony: %s)." % ", ".join(PROGRAM_EXT))
        os.makedirs(self.nc_dir(), exist_ok=True)
        return os.path.join(self.nc_dir(), name)

    def alarms(self, mstat):
        out = []
        rt = self.runtime.status()
        if rt["state"] == "failed":
            out.append(rt["error"] or "LinuxCNC selhalo.")
        if not rt["configured"]:
            out.append("Stroj není nastavený: spusť průvodce v F1 Nastavení.")
        if not self.board_state.get("ok"):
            out.append("Deska EC300 neodpovídá.")
        if mstat:
            if mstat["state"] == "estop":
                out.append("E-stop je aktivní.")
            for j in mstat.get("limits", []):
                out.append("Koncový spínač aktivní na ose %s." % (mstat["dro"][j]["axis"] if j < len(mstat["dro"]) else j))
        return out


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "OpenCNC-Web/" + VERSION

        def log_message(self, fmt, *args):
            pass

        # ---------- pomocné ----------

        def _token(self):
            c = SimpleCookie(self.headers.get("Cookie", ""))
            return c["cnc_session"].value if "cnc_session" in c else None

        def _role(self):
            return app.auth.role(self._token())

        def _send(self, code, body, ctype="application/json; charset=utf-8", headers=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            elif isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _ok(self, **kw):
            self._send(200, dict(ok=True, **kw))

        def _need(self, needed):
            role = self._role()
            if app.auth.needs_setup():
                self._send(403, {"ok": False, "error": "Nejdřív nastav heslo správce.", "needs_setup": True})
                return None
            if not app.auth.allows(role, needed):
                self._send(401 if role is None else 403,
                           {"ok": False, "error": "Přihlas se jako %s." % ("správce" if needed == "admin" else "obsluha"),
                            "login": needed})
                return None
            return role

        def _body(self):
            n = int(self.headers.get("Content-Length", "0"))
            if n > MAX_UPLOAD:
                raise UserError("Soubor je příliš velký.")
            return self.rfile.read(n) if n else b""

        def _json(self):
            b = self._body()
            return json.loads(b.decode("utf-8") or "{}")

        def _machine(self):
            m = app.runtime.get_machine()
            if m is None:
                raise UserError("Řízení (LinuxCNC) neběží. Spusť ho v F5 Diagnostika.")
            return m

        def _require_stopped(self):
            if app.runtime.status()["state"] not in ("stopped", "failed"):
                raise UserError("Tento test jde jen při zastaveném řízení (LinuxCNC).")

        def _error(self, exc):
            if isinstance(exc, (UserError, BoardError, RuntimeError)):
                self._send(400, {"ok": False, "error": str(exc)})
            elif isinstance(exc, (KeyError, ValueError, TypeError)):
                self._send(400, {"ok": False, "error": "Neplatné parametry: %s" % exc})
            else:
                traceback.print_exc()
                self._send(500, {"ok": False, "error": "Chyba serveru: %s" % exc})

        # ---------- GET ----------

        def do_GET(self):
            url = urlparse(self.path)
            q = parse_qs(url.query)
            try:
                if url.path in STATIC:
                    fname, ctype = STATIC[url.path]
                    with open(os.path.join(FRONTEND, fname), "rb") as f:
                        return self._send(200, f.read(), ctype)
                if url.path == "/api/auth":
                    return self._ok(role=self._role(), needs_setup=app.auth.needs_setup(),
                                    operator_required=app.auth.operator_required(), version=VERSION,
                                    demo=app.demo)
                if not self._need("operator"):
                    return
                role = self._role()
                if url.path == "/api/status":
                    m = app.runtime.get_machine()
                    mstat = None
                    if m:
                        try:
                            mstat = m.status()
                        except Exception as e:
                            app.message("error", "Chyba čtení stavu LinuxCNC: %s" % e)
                    since = int(q.get("since", ["0"])[0])
                    return self._ok(role=role, runtime=app.runtime.status(), machine=mstat,
                                    board=app.board_state, alarms=app.alarms(mstat),
                                    messages=[x for x in app.messages if x["id"] > since][-30:],
                                    last_msg=app.msg_seq, server_time=time.time())
                if url.path == "/api/files":
                    files = []
                    d = app.nc_dir()
                    os.makedirs(d, exist_ok=True)
                    for name in os.listdir(d):
                        p = os.path.join(d, name)
                        if os.path.isfile(p) and name.lower().endswith(PROGRAM_EXT):
                            st = os.stat(p)
                            files.append({"name": name, "size": st.st_size, "mtime": st.st_mtime})
                    files.sort(key=lambda f: f["mtime"], reverse=True)
                    return self._ok(files=files)
                if url.path == "/api/file":
                    name = q.get("name", [""])[0]
                    if name:
                        path = app.safe_program_path(name)
                    else:
                        m = app.runtime.get_machine()
                        path = m.loaded_file() if m else ""
                    if not path or not os.path.isfile(path):
                        return self._ok(name="", text="")
                    if os.path.getsize(path) > 8 * 1024 * 1024:
                        raise UserError("Soubor je pro náhled příliš velký (max 8 MB).")
                    with open(path, encoding="utf-8", errors="replace") as f:
                        return self._ok(name=os.path.basename(path), text=f.read())
                if url.path == "/api/tools":
                    m = app.runtime.get_machine()
                    if m:
                        return self._ok(tools=m.read_tools())
                    from .machine import Machine
                    tt = os.path.join(app.runtime.machine_dir, "tool.tbl")
                    return self._ok(tools=Machine.read_tools(type("T", (), {"tool_table_path": tt})()))
                if url.path == "/api/diag":
                    bs = dict(app.board_state)
                    mach = app.runtime.load_machine()
                    names = {}
                    if mach:
                        for bit, cfg in mach["inputs"].items():
                            names[int(bit)] = configgen.INPUT_FUNCTIONS.get(cfg["function"], "")
                    onames = {}
                    if mach:
                        for bit, f in mach["outputs"].items():
                            onames[int(bit)] = configgen.OUTPUT_FUNCTIONS.get(f, "")
                    return self._ok(
                        board=bs, runtime=app.runtime.status(),
                        inputs=[{"bit": b, "terminal": t, "function": names.get(b, ""),
                                 "on": bool(bs.get("inputs", 0) & (1 << b))} for b, t, _ in configgen.EC300_INPUTS],
                        outputs=[{"bit": b, "terminal": t, "function": onames.get(b, ""),
                                  "on": bool(bs.get("outputs", 0) & (1 << b))} for b, t, _ in configgen.EC300_OUTPUTS],
                        system=app.get_sysinfo(),
                        log=app.runtime.log_tail() if app.auth.allows(role, "admin") else "",
                        job=app.jobs.get())
                if url.path == "/api/job":
                    return self._ok(job=app.jobs.get(q.get("id", [None])[0]))
                if url.path == "/api/setup":
                    if not self._need("admin"):
                        return
                    current = app.runtime.load_machine()
                    return self._ok(machine=current or configgen.default_machine(), configured=current is not None,
                                    inputs=[{"bit": b, "terminal": t} for b, t, _ in configgen.EC300_INPUTS],
                                    outputs=[{"bit": b, "terminal": t} for b, t, _ in configgen.EC300_OUTPUTS],
                                    input_functions=configgen.INPUT_FUNCTIONS,
                                    output_functions=configgen.OUTPUT_FUNCTIONS,
                                    history=app.runtime.history())
                return self._send(404, {"ok": False, "error": "Nenalezeno"})
            except Exception as exc:
                self._error(exc)

        # ---------- POST ----------

        def do_POST(self):
            url = urlparse(self.path)
            q = parse_qs(url.query)
            try:
                p = url.path
                # --- přihlášení ---
                if p == "/api/auth/setup":
                    if not app.auth.needs_setup():
                        raise UserError("Heslo správce už je nastavené.")
                    a = self._json()
                    app.auth.set_passwords(admin=a.get("admin", ""), operator=a.get("operator", ""))
                    token = app.auth.login("admin", a.get("admin", ""))
                    return self._send(200, {"ok": True}, headers={"Set-Cookie": self._cookie(token)})
                if p == "/api/auth/login":
                    a = self._json()
                    token = app.auth.login(a.get("role", "operator"), a.get("password", ""))
                    if not token:
                        raise UserError("Špatné heslo.")
                    return self._send(200, {"ok": True}, headers={"Set-Cookie": self._cookie(token)})
                if p == "/api/auth/logout":
                    app.auth.logout(self._token())
                    return self._send(200, {"ok": True},
                                      headers={"Set-Cookie": "cnc_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"})
                if p == "/api/auth/passwords":
                    if not self._need("admin"):
                        return
                    a = self._json()
                    app.auth.set_passwords(admin=a.get("admin") or None,
                                           operator=a.get("operator") if "operator" in a else None)
                    return self._ok()

                # --- obsluha ---
                if not self._need("operator"):
                    return
                if p == "/api/cmd":
                    a = self._json()
                    cmd = str(a.get("cmd", ""))
                    m = app.runtime.get_machine()
                    if m is None and cmd in ("estop", "jog_stop", "jog_keep", "stop"):
                        return self._ok()
                    self._machine().command(cmd, a)
                    return self._ok()
                if p == "/api/files/upload":
                    path = app.safe_program_path(q.get("name", [""])[0])
                    data = self._body()
                    with open(path + ".part", "wb") as f:
                        f.write(data)
                    os.replace(path + ".part", path)
                    app.message("info", "Nahrán program %s (%d kB)." % (os.path.basename(path), len(data) // 1024))
                    return self._ok(name=os.path.basename(path))
                if p == "/api/files/open":
                    path = app.safe_program_path(self._json().get("name"))
                    if not os.path.isfile(path):
                        raise UserError("Soubor neexistuje.")
                    self._machine().command("open", {"path": path})
                    return self._ok()
                if p == "/api/files/delete":
                    path = app.safe_program_path(self._json().get("name"))
                    m = app.runtime.get_machine()
                    if m and m.loaded_file() == path and m.status()["interp"] != "idle":
                        raise UserError("Soubor právě běží.")
                    os.remove(path)
                    return self._ok()
                if p == "/api/tools":
                    self._machine().write_tools(self._json().get("tools", []))
                    return self._ok()
                if p == "/api/runtime":
                    self._json_cache = self._json()
                    action = self._json_cache.get("action")
                    if action == "start":
                        if app.runtime.commissioning_pending():
                            if not self._need("admin"):
                                return
                            if not self._json_cache.get("confirm_safety"):
                                raise UserError("Potvrď kontrolu bezpečnostních obvodů.")
                            app.runtime.confirm_commissioning()
                            app.message("info", "Správce potvrdil kontrolu bezpečnosti nové konfigurace.")
                        app.runtime.start()
                    elif action in ("stop", "restart"):
                        if not self._need("admin"):
                            return
                        if action == "restart":
                            threading.Thread(target=app.runtime.restart, daemon=True).start()
                        else:
                            app.runtime.stop()
                    else:
                        raise UserError("Neznámá akce.")
                    return self._ok()

                # --- správce ---
                if not self._need("admin"):
                    return
                if p == "/api/setup/validate":
                    m = configgen.normalize(self._json().get("machine", {}))
                    errors, warnings = configgen.validate(m)
                    axes = []
                    for a in m["axes"]:
                        try:
                            sc = configgen.axis_scale(a)
                            axes.append({"letter": a["letter"], "scale": round(sc, 4),
                                         "step_khz": round(abs(sc) * a["max_vel"] / 60000.0, 2)})
                        except Exception:
                            axes.append({"letter": a["letter"], "scale": None, "step_khz": None})
                    return self._ok(errors=errors, warnings=warnings, axes=axes,
                                    files={"remora.ini": configgen.ini_text(m, {"display": "headless.py", "nc_files": "nc_files"}),
                                           "remora.hal": configgen.hal_text(m),
                                           "remora.json": configgen.remora_json(m)})
                if p == "/api/setup/apply":
                    a = self._json()
                    machine, start = a.get("machine", {}), bool(a.get("start"))

                    def job(log):
                        res = app.runtime.apply(machine, upload=True, log=log)
                        if start:
                            # vyplnění průvodce nesmí samo povolit pohyb: spuštění až po potvrzení kontroly
                            log("Pro spuštění potvrď kontrolu bezpečnosti v F5 Diagnostika → Spustit.")
                        log("Hotovo.")
                        return res
                    return self._ok(job=app.jobs.start("Uložení nastavení stroje", job))
                if p == "/api/setup/rollback":
                    sid = self._json().get("id")
                    return self._ok(job=app.jobs.start("Návrat ke konfiguraci %s" % sid,
                                                       lambda log: app.runtime.rollback(sid, log)))
                if p == "/api/diag/output":
                    self._require_stopped()
                    a = self._json()
                    app.board.set_output(int(a["bit"]), bool(a["value"]))
                    return self._ok()
                if p == "/api/diag/pwm":
                    self._require_stopped()
                    app.board.set_pwm(float(self._json()["percent"]))
                    return self._ok()
                if p == "/api/diag/motor":
                    self._require_stopped()
                    a = self._json()
                    app.board.motor(int(a["joint"]), int(a["freq"]))
                    return self._ok()
                if p == "/api/diag/stop":
                    app.board.stop_session()
                    return self._ok()
                if p == "/api/jobs/latency":
                    secs = int(self._json().get("seconds", 60))
                    return self._ok(job=app.jobs.start("Test latence", lambda log: system.latency_test(log, secs, app.demo)))
                if p == "/api/jobs/check_updates":
                    return self._ok(job=app.jobs.start("Kontrola aktualizací", lambda log: system.check_updates(log, app.demo)))
                if p == "/api/jobs/upgrade":
                    self._require_stopped()
                    return self._ok(job=app.jobs.start("Aktualizace systému", lambda log: system.upgrade_system(log, app.demo)))
                if p == "/api/jobs/halcomp":
                    self._require_stopped()
                    return self._ok(job=app.jobs.start("Instalace komponenty Remora", lambda log: system.install_hal_component(log, app.demo)))
                if p == "/api/jobs/flash":
                    self._require_stopped()
                    data = self._body()
                    if len(data) < 1024 or data[:4] != b"FCFB":
                        raise UserError("Soubor není firmware pro RT1052 (chybí hlavička FCFB).")
                    path = os.path.join(app.runtime.data_dir, "firmware-upload.bin")
                    with open(path, "wb") as f:
                        f.write(data)
                    return self._ok(job=app.jobs.start("Nahrání firmwaru do EC300", lambda log: system.flash_firmware(log, path, app.demo)))
                if p == "/api/system/power":
                    self._require_stopped()
                    system.power(self._json().get("action"), app.demo)
                    return self._ok()
                return self._send(404, {"ok": False, "error": "Nenalezeno"})
            except Exception as exc:
                self._error(exc)

        @staticmethod
        def _cookie(token):
            return "cnc_session=%s; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict" % token

    return Handler


def serve(app, host, port):
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    httpd.daemon_threads = True
    print("OpenCNC Web %s běží na http://%s:%d/" % (VERSION, host, port), flush=True)
    httpd.serve_forever()
