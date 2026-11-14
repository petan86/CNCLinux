"""
Ovládání běžícího LinuxCNC přes jeho Python API (linuxcnc.stat / command / error_channel).

Webová aplikace není součástí real-time smyčky: posílá jen příkazy do LinuxCNC
(task), pohyb počítá LinuxCNC a kroky generuje Remora na desce.
"""

import os
import threading
import time

AXES = "XYZABCUVW"
JOG_TIMEOUT_S = 0.4
WAIT_TIMEOUT_S = 2.0


class UserError(Exception):
    """Chyba, kterou zobrazíme obsluze."""


class Machine:
    def __init__(self, lc, hal, ini_path, on_message):
        self.lc = lc
        self.hal = hal
        self.on_message = on_message
        self.lock = threading.RLock()
        self.s = lc.stat()
        self.c = lc.command()
        self.e = lc.error_channel()
        self.s.poll()
        self.ini = lc.ini(ini_path)
        self.config_dir = os.path.dirname(os.path.abspath(ini_path))

        def ini_float(section, key, default):
            try:
                return float(self.ini.find(section, key))
            except (TypeError, ValueError):
                return default

        self.max_lin_vel = ini_float("DISPLAY", "MAX_LINEAR_VELOCITY", 25.0)
        self.max_feed_override = ini_float("DISPLAY", "MAX_FEED_OVERRIDE", 1.2)
        self.max_spindle_override = ini_float("DISPLAY", "MAX_SPINDLE_OVERRIDE", 1.2)
        tt = self.ini.find("EMCIO", "TOOL_TABLE") or "tool.tbl"
        self.tool_table_path = tt if os.path.isabs(tt) else os.path.join(self.config_dir, tt)
        self.jog = None
        self.closed = False
        threading.Thread(target=self._watchdog, daemon=True).start()

    def close(self):
        with self.lock:
            self._jog_stop_locked()
            self.closed = True

    # ---------- pomocné ----------

    def _poll_errors(self):
        lc = self.lc
        while True:
            err = self.e.poll()
            if not err:
                break
            kind, text = err
            self.on_message("error" if kind in (lc.NML_ERROR, lc.OPERATOR_ERROR) else "info", text)

    def _wait(self):
        self.c.wait_complete(WAIT_TIMEOUT_S)

    def _require_on(self):
        if self.s.task_state != self.lc.STATE_ON:
            raise UserError("Stroj není zapnutý (uvolni E-stop a zapni stroj).")

    def _require_idle(self):
        if self.s.interp_state != self.lc.INTERP_IDLE:
            raise UserError("Řízení není volné: běží program nebo MDI.")

    def _require_homed(self, what):
        if not self._all_homed():
            raise UserError("%s: nejdřív stroj zreferuj." % what)

    def _set_mode(self, mode):
        self.s.poll()
        if self.s.task_mode != mode:
            self.c.mode(mode)
            self._wait()
            self.s.poll()

    def _axes(self):
        return [i for i in range(9) if self.s.axis_mask & (1 << i)]

    def _all_homed(self):
        return all(self.s.homed[j] for j in range(self.s.joints))

    def _axis_to_joint(self, axis_index):
        axes = self._axes()
        if axis_index not in axes:
            raise UserError("Osa %s není ve stroji." % AXES[axis_index])
        return axes.index(axis_index)

    # ---------- stav ----------

    def status(self):
        with self.lock:
            s, lc = self.s, self.lc
            s.poll()
            self._poll_errors()
            axes = self._axes()
            pos = s.actual_position
            dro = []
            for i in axes:
                off = s.g5x_offset[i] + s.g92_offset[i] + s.tool_offset[i]
                dro.append({"axis": AXES[i], "index": i, "work": round(pos[i] - off, 4),
                            "machine": round(pos[i], 4), "dtg": round(s.dtg[i], 4)})
            homed = [bool(s.homed[j]) for j in range(s.joints)]
            limits = []
            for j in range(s.joints):
                lim = s.limit[j] if hasattr(s, "limit") else 0
                if lim:
                    limits.append(j)
            sp = s.spindle[0] if getattr(s, "spindles", 0) > 0 else {}
            return {
                "state": {lc.STATE_ESTOP: "estop", lc.STATE_ESTOP_RESET: "off",
                          lc.STATE_OFF: "off", lc.STATE_ON: "on"}.get(s.task_state, "unknown"),
                "mode": {lc.MODE_MANUAL: "manual", lc.MODE_AUTO: "auto", lc.MODE_MDI: "mdi"}.get(s.task_mode, "?"),
                "interp": {lc.INTERP_IDLE: "idle", lc.INTERP_READING: "running", lc.INTERP_PAUSED: "paused",
                           lc.INTERP_WAITING: "running"}.get(s.interp_state, "?"),
                "homed": homed, "all_homed": bool(homed) and all(homed),
                "limits": limits,
                "dro": dro, "units": "mm" if abs(s.linear_units - 1.0) < 1e-3 else "in",
                "g5x_index": s.g5x_index,
                "tool": s.tool_in_spindle,
                "gcodes": self._active_gcodes(),
                "flood": bool(getattr(s, "flood", 0)), "mist": bool(getattr(s, "mist", 0)),
                "g5x_offset": [round(s.g5x_offset[i], 4) for i in axes],
                "feedrate_cmd": round(getattr(s, "current_vel", 0.0) * 60.0, 1),
                "feed_override": s.feedrate, "rapid_override": s.rapidrate,
                "max_feed_override": self.max_feed_override, "max_spindle_override": self.max_spindle_override,
                "spindle": {"speed": sp.get("speed", 0.0), "override": sp.get("override", 1.0),
                            "enabled": bool(sp.get("enabled", 0)), "direction": sp.get("direction", 0)},
                "file": os.path.basename(s.file) if s.file else "", "file_path": s.file or "",
                "current_line": s.current_line, "motion_line": s.motion_line,
                "max_jog_velocity": self.max_lin_vel,
                "jogging": self.jog is not None,
            }

    def _active_gcodes(self):
        """Aktivní modální G-kódy pro lištu pod náhledem (pohyb, rovina, souřadnice, jednotky, korekce)."""
        names = {0: "G0 Rychloposuv", 10: "G1 Lineární", 20: "G2 Oblouk CW", 30: "G3 Oblouk CCW", 800: "G80",
                 170: "G17 XY", 180: "G18 XZ", 190: "G19 YZ", 900: "G90 Absolutně", 910: "G91 Přírůstkově",
                 940: "G94 mm/min", 930: "G93 Inverzní", 200: "G20 palce", 210: "G21 mm",
                 400: "G40 Bez korekce", 410: "G41 Korekce L", 420: "G42 Korekce P",
                 430: "G43 Délka nástroje", 490: "G49 Bez délky"}
        out = []
        for g in getattr(self.s, "gcodes", ())[1:]:
            if g in names and names[g] not in out:
                out.append(names[g])
        return out

    def read_offsets(self):
        """G54-G59 z linuxcnc.var (parametry 5221...); aktivní systém živě z LinuxCNC."""
        with self.lock:
            self.s.poll()
            axes = self._axes()
            active = self.s.g5x_index
            live = list(self.s.g5x_offset)
        params = {}
        var = os.path.join(self.config_dir, self.ini.find("RS274NGC", "PARAMETER_FILE") or "linuxcnc.var")
        try:
            with open(var, encoding="utf-8", errors="replace") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) >= 2 and parts[0].isdigit():
                        params[int(parts[0])] = float(parts[1])
        except (OSError, ValueError):
            pass
        rows = []
        for n in range(1, 7):
            base = 5221 + (n - 1) * 20
            vals = [live[i] if n == active else params.get(base + i, 0.0) for i in axes]
            rows.append({"index": n, "name": "G%d" % (53 + n), "active": n == active,
                         "values": [round(v, 4) for v in vals]})
        return {"axes": [AXES[i] for i in axes], "rows": rows}

    def hal_inputs(self, count):
        """Stav vstupů remora.input.NN, když běží LinuxCNC."""
        bits = 0
        for n in range(count):
            try:
                if self.hal.get_value("remora.input.%02d" % n):
                    bits |= 1 << n
            except Exception:
                pass
        return bits

    def hal_value(self, name):
        try:
            return self.hal.get_value(name)
        except Exception:
            return None

    def loaded_file(self):
        with self.lock:
            self.s.poll()
            return self.s.file

    # ---------- nástroje ----------

    def read_tools(self):
        tools = []
        if os.path.exists(self.tool_table_path):
            with open(self.tool_table_path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    body, _, comment = line.partition(";")
                    fields = {w[0].upper(): w[1:] for w in body.split() if len(w) > 1}
                    if "T" not in fields:
                        continue
                    try:
                        tools.append({"t": int(fields["T"]), "p": int(fields.get("P", fields["T"])),
                                      "z": float(fields.get("Z", 0)), "d": float(fields.get("D", 0)),
                                      "comment": comment.strip()})
                    except ValueError:
                        continue
        return sorted(tools, key=lambda t: t["t"])

    def write_tools(self, tools):
        with self.lock:
            self.s.poll()
            self._require_idle()
            lines = []
            for t in sorted(tools, key=lambda x: int(x["t"])):
                n = int(t["t"])
                if n <= 0 or n > 9999:
                    raise UserError("Číslo nástroje musí být 1–9999.")
                comment = str(t.get("comment", "")).replace("\n", " ")[:60]
                lines.append("T%d P%d Z%.4f D%.4f ;%s" % (n, int(t.get("p") or n), float(t["z"]), float(t["d"]), comment))
            tmp = self.tool_table_path + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="\n") as f:
                f.write("\n".join(lines) + "\n")
            os.replace(tmp, self.tool_table_path)
            self.c.load_tool_table()

    # ---------- příkazy ----------

    def command(self, cmd, a):
        lc = self.lc
        with self.lock:
            self.s.poll()
            c = self.c
            if cmd == "estop":
                self._jog_stop_locked()
                c.state(lc.STATE_ESTOP)
            elif cmd == "estop_reset":
                c.state(lc.STATE_ESTOP_RESET)
            elif cmd == "machine_on":
                if self.s.task_state == lc.STATE_ESTOP:
                    raise UserError("Nejdřív uvolni E-stop.")
                c.state(lc.STATE_ON)
            elif cmd == "machine_off":
                self._jog_stop_locked()
                c.state(lc.STATE_OFF)
            elif cmd in ("home_all", "home", "unhome_all"):
                self._require_on(); self._require_idle()
                self._set_mode(lc.MODE_MANUAL)
                c.teleop_enable(0); self._wait()
                if cmd == "home_all":
                    c.home(-1)
                elif cmd == "home":
                    c.home(self._axis_to_joint(int(a["axis"])))
                else:
                    c.unhome(-1)
            elif cmd == "mdi":
                text = str(a.get("text", "")).strip()
                if not text or len(text) > 250 or "\n" in text:
                    raise UserError("Neplatný MDI příkaz.")
                self._require_on(); self._require_idle(); self._require_homed("MDI")
                self._set_mode(lc.MODE_MDI)
                c.mdi(text)
            elif cmd == "touchoff":
                axis = int(a["axis"])
                self._require_on(); self._require_idle(); self._require_homed("Nulový bod")
                self._set_mode(lc.MODE_MDI)
                c.mdi("G10 L20 P0 %s%.4f" % (AXES[axis], float(a.get("value", 0.0))))
                self._wait()
                self._set_mode(lc.MODE_MANUAL)
            elif cmd == "select_wcs":
                n = int(a["index"])
                if not 1 <= n <= 9:
                    raise UserError("Neplatný souřadný systém.")
                self._require_on(); self._require_idle(); self._require_homed("Souřadný systém")
                self._set_mode(lc.MODE_MDI)
                c.mdi(["G54", "G55", "G56", "G57", "G58", "G59", "G59.1", "G59.2", "G59.3"][n - 1])
                self._wait()
                self._set_mode(lc.MODE_MANUAL)
            elif cmd == "set_offset":
                n, axis = int(a["index"]), int(a["axis"])
                if not 1 <= n <= 6:
                    raise UserError("Neplatný souřadný systém.")
                self._require_on(); self._require_idle(); self._require_homed("Pracovní offset")
                self._set_mode(lc.MODE_MDI)
                c.mdi("G10 L2 P%d %s%.4f" % (n, AXES[axis], float(a["value"])))
                self._wait()
                self._set_mode(lc.MODE_MANUAL)
            elif cmd == "goto_origin":
                # bezpečně: nejdřív Z nahoru do strojní nuly, pak XY na nulu obrobku
                self._require_on(); self._require_idle(); self._require_homed("Najetí na nulu")
                self._set_mode(lc.MODE_MDI)
                c.mdi("G53 G0 Z0")
                self._wait()
                c.mdi("G0 X0 Y0")
            elif cmd == "spindle":
                d = a.get("dir")
                self._require_on(); self._require_idle(); self._require_homed("Vřeteno")
                self._set_mode(lc.MODE_MDI)
                if d == "stop":
                    c.mdi("M5")
                else:
                    rpm = float(a.get("rpm", 0))
                    if rpm <= 0:
                        raise UserError("Zadej otáčky vřetena.")
                    c.mdi("%s S%d" % ("M3" if d == "cw" else "M4", int(rpm)))
            elif cmd == "coolant":
                self._require_on(); self._require_idle(); self._require_homed("Chlazení")
                self._set_mode(lc.MODE_MDI)
                c.mdi("M8" if a.get("on") else "M9")
            elif cmd == "tool_change":
                n = int(a["tool"])
                self._require_on(); self._require_idle(); self._require_homed("Výměna nástroje")
                self._set_mode(lc.MODE_MDI)
                c.mdi("M6 T%d G43" % n)
            elif cmd == "open":
                path = a["path"]
                self._require_idle()
                self._set_mode(lc.MODE_AUTO)
                c.program_open(path)
            elif cmd == "run":
                self._require_on(); self._require_idle(); self._require_homed("Spuštění programu")
                if not self.s.file:
                    raise UserError("Není načtený žádný program.")
                self._set_mode(lc.MODE_AUTO)
                c.auto(lc.AUTO_RUN, int(a.get("line", 0)))
            elif cmd == "pause":
                c.auto(lc.AUTO_PAUSE)
            elif cmd == "resume":
                c.auto(lc.AUTO_RESUME)
            elif cmd == "step":
                self._require_on(); self._require_homed("Krokování")
                if self.s.interp_state == lc.INTERP_IDLE:
                    self._set_mode(lc.MODE_AUTO)
                c.auto(lc.AUTO_STEP)
            elif cmd == "stop":
                self._jog_stop_locked()
                c.abort()
            elif cmd == "feed_override":
                c.feedrate(max(0.0, min(float(a["value"]), self.max_feed_override)))
            elif cmd == "rapid_override":
                c.rapidrate(max(0.0, min(float(a["value"]), 1.0)))
            elif cmd == "spindle_override":
                c.spindleoverride(max(0.0, min(float(a["value"]), self.max_spindle_override)), 0)
            elif cmd == "jog_start":
                self._jog_start_locked(int(a["axis"]), int(a["dir"]),
                                       float(a.get("velocity", self.max_lin_vel / 4)),
                                       float(a.get("increment", 0.0)))
            elif cmd == "jog_keep":
                if self.jog is not None:
                    self.jog["last"] = time.monotonic()
            elif cmd == "jog_stop":
                self._jog_stop_locked()
            else:
                raise UserError("Neznámý příkaz: %s" % cmd)

    # ---------- jog s deadman ----------

    def _jog_start_locked(self, axis, direction, velocity, increment):
        lc, c = self.lc, self.c
        if not 0 <= axis <= 8:
            raise UserError("Neplatná osa.")
        self._require_on(); self._require_idle()
        self._jog_stop_locked()
        self._set_mode(lc.MODE_MANUAL)
        teleop = self._all_homed()
        c.teleop_enable(1 if teleop else 0)
        self._wait()
        jjogmode = not teleop
        index = axis if teleop else self._axis_to_joint(axis)
        vel = max(0.001, min(abs(velocity), self.max_lin_vel)) * (1 if direction > 0 else -1)
        if increment > 0:
            c.jog(lc.JOG_INCREMENT, jjogmode, index, vel, abs(increment))
        else:
            c.jog(lc.JOG_CONTINUOUS, jjogmode, index, vel)
            self.jog = {"index": index, "jjogmode": jjogmode, "last": time.monotonic()}

    def _jog_stop_locked(self):
        if self.jog is not None:
            j, self.jog = self.jog, None
            try:
                self.c.jog(self.lc.JOG_STOP, j["jjogmode"], j["index"])
            except Exception:
                pass

    def _watchdog(self):
        while not self.closed:
            time.sleep(0.05)
            with self.lock:
                if self.jog is not None and time.monotonic() - self.jog["last"] > JOG_TIMEOUT_S:
                    self._jog_stop_locked()
                    self.on_message("warn", "Ruční posuv zastaven: tablet přestal posílat signál (Wi-Fi?).")
