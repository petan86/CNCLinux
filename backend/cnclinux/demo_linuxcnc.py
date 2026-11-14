"""
Jednoduchá simulace modulu `linuxcnc` pro vyzkoušení Remora WebUI bez stroje.
Napodobuje jen to, co webové rozhraní používá. Nejde o simulaci pohybu LinuxCNC.
"""

import re
import threading
import time

STATE_ESTOP, STATE_ESTOP_RESET, STATE_OFF, STATE_ON = 1, 2, 3, 4
MODE_MANUAL, MODE_AUTO, MODE_MDI = 1, 2, 3
INTERP_IDLE, INTERP_READING, INTERP_PAUSED, INTERP_WAITING = 1, 2, 3, 4
JOG_STOP, JOG_CONTINUOUS, JOG_INCREMENT = 0, 1, 2
AUTO_RUN, AUTO_PAUSE, AUTO_RESUME, AUTO_STEP = 0, 1, 2, 3
NML_ERROR, NML_TEXT, NML_DISPLAY, OPERATOR_ERROR, OPERATOR_TEXT, OPERATOR_DISPLAY = 1, 2, 3, 11, 12, 13

class _Sim:
    def __init__(self):
        self.lock = threading.RLock()
        self.task_state = STATE_ESTOP
        self.task_mode = MODE_MANUAL
        self.interp_state = INTERP_IDLE
        self.pos = [12.5, 30.0, -4.0] + [0.0] * 6
        self.g5x = [0.0] * 9
        self.homed = [0, 0, 0]
        self.feed, self.rapid, self.spov = 1.0, 1.0, 1.0
        self.spindle_speed, self.spindle_dir = 0.0, 0
        self.file = ""
        self.line = 0
        self.jog = None          # (axis, vel)
        self.errors = []
        self.tool = 0
        self.flood = 0
        self.step_once = False
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        last = time.monotonic()
        next_line = 0.0
        while True:
            time.sleep(0.02)
            now = time.monotonic()
            dt, last = now - last, now
            with self.lock:
                if self.jog and self.task_state == STATE_ON:
                    a, v = self.jog
                    self.pos[a] += v * dt
                if self.interp_state == INTERP_READING and now >= next_line:
                    next_line = now + 0.4
                    self._exec_next_line()

    def _exec_next_line(self):
        try:
            with open(self.file) as f:
                lines = f.read().splitlines()
        except OSError:
            self.interp_state = INTERP_IDLE
            return
        if self.line >= len(lines):
            self.interp_state = INTERP_IDLE
            self.line = 0
            return
        self.line += 1
        self.apply_gcode(lines[self.line - 1])
        if self.step_once:
            self.step_once = False
            self.interp_state = INTERP_PAUSED

    def apply_gcode(self, text):
        t = re.sub(r"\(.*?\)", "", text.upper())
        m = re.search(r"G10\s*L20\s*P0\s*([XYZ])\s*(-?[\d.]+)", t)
        if m:
            i = "XYZ".index(m.group(1))
            self.g5x[i] = self.pos[i] - float(m.group(2))
            return
        for ax, val in re.findall(r"([XYZ])\s*(-?[\d.]+)", t):
            i = "XYZ".index(ax)
            self.pos[i] = float(val) + self.g5x[i]
        tm = re.search(r"M0?6\s*T\s*(\d+)", t)
        if tm:
            self.tool = int(tm.group(1))
        s = re.search(r"S\s*([\d.]+)", t)
        if s:
            self.spindle_speed = float(s.group(1))
        if re.search(r"M0?8\b", t):
            self.flood = 1
        if re.search(r"M0?9\b", t):
            self.flood = 0
        if re.search(r"G10\s*L2\s*P", t):
            return
        if re.search(r"M0?3\b", t):
            self.spindle_dir = 1
        if re.search(r"M0?5\b", t) or re.search(r"M0?2\b", t):
            self.spindle_dir = 0
        if re.search(r"M0?2\b|M30\b", t):
            self.interp_state = INTERP_IDLE
            self.line = 0


_sim = _Sim()


class stat:
    def poll(self):
        s = _sim
        with s.lock:
            self.ini_filename = ""
            self.tool_in_spindle = s.tool
            self.gcodes = (0, 10 if s.interp_state != INTERP_IDLE else 0, 170, 900, 940, 210, 400, 490, 800)
            self.flood = s.flood
            self.mist = 0
            self.current_vel = 13.3 if s.interp_state == INTERP_READING else 0.0
            self.limit = (0,) * 16
            self.task_state, self.task_mode, self.interp_state = s.task_state, s.task_mode, s.interp_state
            self.estop = 1 if s.task_state == STATE_ESTOP else 0
            self.axis_mask = 0b111
            self.joints = 3
            self.homed = tuple(s.homed) + (0,) * 13
            self.actual_position = tuple(s.pos)
            self.g5x_offset = tuple(s.g5x)
            self.g92_offset = (0.0,) * 9
            self.tool_offset = (0.0,) * 9
            self.dtg = (0.0,) * 9
            self.g5x_index = 1
            self.linear_units = 1.0
            self.feedrate, self.rapidrate = s.feed, s.rapid
            self.spindles = 1
            self.spindle = ({"speed": s.spindle_speed * s.spindle_dir, "override": s.spov,
                             "enabled": 1 if s.spindle_dir else 0, "direction": s.spindle_dir},)
            self.file = s.file
            self.current_line = s.line
            self.motion_line = s.line


class command:
    def wait_complete(self, timeout=5.0):
        return 1

    def state(self, st):
        with _sim.lock:
            if st == STATE_ESTOP:
                _sim.task_state, _sim.jog, _sim.interp_state = STATE_ESTOP, None, INTERP_IDLE
                _sim.spindle_dir = 0
            elif st == STATE_ESTOP_RESET:
                _sim.task_state = STATE_ESTOP_RESET
            elif st == STATE_ON and _sim.task_state != STATE_ESTOP:
                _sim.task_state = STATE_ON
            elif st == STATE_OFF:
                _sim.task_state, _sim.jog = STATE_OFF, None

    def unhome(self, j):
        with _sim.lock:
            _sim.homed = [0, 0, 0]

    def load_tool_table(self):
        pass

    def mode(self, m):
        _sim.task_mode = m

    def teleop_enable(self, v):
        pass

    def home(self, j):
        with _sim.lock:
            joints = range(3) if j < 0 else [j]
            for k in joints:
                _sim.homed[k] = 1
                _sim.pos[k] = 0.0

    def jog(self, kind, jjogmode, index, vel=0.0, incr=0.0):
        with _sim.lock:
            if kind == JOG_STOP:
                _sim.jog = None
            elif kind == JOG_CONTINUOUS:
                _sim.jog = (index, vel)
            elif kind == JOG_INCREMENT:
                _sim.pos[index] += incr if vel > 0 else -incr

    def mdi(self, text):
        with _sim.lock:
            _sim.apply_gcode(text)

    def program_open(self, path):
        with _sim.lock:
            _sim.file, _sim.line = path, 0

    def auto(self, kind, line=0):
        with _sim.lock:
            if kind == AUTO_RUN:
                _sim.line, _sim.interp_state = line, INTERP_READING
            elif kind == AUTO_PAUSE and _sim.interp_state == INTERP_READING:
                _sim.interp_state = INTERP_PAUSED
            elif kind == AUTO_RESUME and _sim.interp_state == INTERP_PAUSED:
                _sim.interp_state = INTERP_READING
            elif kind == AUTO_STEP:
                _sim.step_once, _sim.interp_state = True, INTERP_READING

    def abort(self):
        with _sim.lock:
            _sim.interp_state, _sim.jog, _sim.line, _sim.spindle_dir = INTERP_IDLE, None, 0, 0

    def feedrate(self, v):
        _sim.feed = v

    def rapidrate(self, v):
        _sim.rapid = v

    def spindleoverride(self, v, spindle=0):
        _sim.spov = v


class error_channel:
    def poll(self):
        with _sim.lock:
            return _sim.errors.pop(0) if _sim.errors else None


class ini:
    def __init__(self, path):
        self.data = {}
        section = None
        with open(path) as f:
            for raw in f:
                line = raw.strip()
                if line.startswith("[") and line.endswith("]"):
                    section = line[1:-1]
                elif "=" in line and section:
                    k, v = line.split("=", 1)
                    self.data.setdefault((section, k.strip()), []).append(v.strip())

    def find(self, section, key):
        v = self.data.get((section, key))
        return v[0] if v else None

    def findall(self, section, key):
        return self.data.get((section, key), [])


class _Hal:
    def get_value(self, name):
        # koncáky v klidu sepnuté, EP podle stavu E-stopu
        if name.endswith(".23"):
            return _sim.task_state != STATE_ESTOP
        return int(time.time() / 3) % 7 == int(name[-1]) % 7


hal = _Hal()
