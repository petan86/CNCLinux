"""
CNC Runtime: spouštění a zastavování LinuxCNC a správa konfigurace stroje.

LinuxCNC běží jako samostatný proces s headless "displejem" (headless.py),
takže webová aplikace může běžet i bez něj: nastavení, diagnostika a aktualizace
fungují i při zastaveném nebo chybně nakonfigurovaném řízení.

Konfigurace:
  <data>/machine/            aktuální konfigurace (machine.json + vygenerované soubory)
  <data>/history/<čas>/      zálohy před každou změnou
  <data>/history/LAST_GOOD   záloha, se kterou naposledy LinuxCNC běžel a deska odpovídala
"""

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time

from . import configgen
from .machine import Machine, UserError

HERE = os.path.dirname(os.path.abspath(__file__))
HEADLESS = os.path.join(HERE, "headless.py")
HEADLESS_PID = "/tmp/cnclinux-headless.pid"
GOOD_AFTER_S = 10          # konfigurace je "funkční" po 10 s běhu s komunikací s deskou


class Runtime:
    def __init__(self, data_dir, board, lc, hal, demo=False, on_message=None):
        self.data_dir = data_dir
        self.machine_dir = os.path.join(data_dir, "machine")
        self.history_dir = os.path.join(data_dir, "history")
        self.log_path = os.path.join(data_dir, "linuxcnc.log")
        os.makedirs(self.machine_dir, exist_ok=True)
        os.makedirs(self.history_dir, exist_ok=True)
        self.board = board
        self.lc = lc
        self.hal = hal
        self.demo = demo
        self.on_message = on_message or (lambda k, t: None)
        self.lock = threading.RLock()
        self.proc = None
        self.state = "stopped"          # stopped / starting / running / stopping / failed
        self.started_at = None
        self.error = ""
        self.machine = None
        self.good_marked = False
        threading.Thread(target=self._monitor, daemon=True).start()

    # ---------------------------------------------------------------- konfigurace

    @property
    def commission_flag(self):
        return os.path.join(self.machine_dir, "COMMISSION_PENDING")

    def commissioning_pending(self):
        return os.path.exists(self.commission_flag)

    def confirm_commissioning(self):
        if os.path.exists(self.commission_flag):
            os.remove(self.commission_flag)

    @property
    def ini_path(self):
        return os.path.join(self.machine_dir, "remora.ini")

    def load_machine(self):
        p = os.path.join(self.machine_dir, "machine.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return configgen.normalize(json.load(f))
        return None

    def is_configured(self):
        return os.path.exists(self.ini_path) and self.load_machine() is not None

    def _snapshot(self, reason):
        if not os.path.exists(os.path.join(self.machine_dir, "machine.json")):
            return None
        name = time.strftime("%Y%m%d-%H%M%S")
        dst = os.path.join(self.history_dir, name)
        n = 1
        while os.path.exists(dst):
            dst = os.path.join(self.history_dir, "%s-%d" % (name, n)); n += 1
        os.makedirs(dst)
        for f in ("machine.json", "remora.ini", "remora.hal", "remora.json", "custom.hal", "tool.tbl"):
            src = os.path.join(self.machine_dir, f)
            if os.path.exists(src):
                shutil.copy2(src, dst)
        with open(os.path.join(dst, "REASON"), "w", encoding="utf-8") as fh:
            fh.write(reason)
        self._prune_history(30)
        return os.path.basename(dst)

    def _prune_history(self, keep):
        good = self.last_good()
        items = sorted(d for d in os.listdir(self.history_dir) if os.path.isdir(os.path.join(self.history_dir, d)))
        for d in items[:-keep]:
            if d != good:
                shutil.rmtree(os.path.join(self.history_dir, d), ignore_errors=True)

    def last_good(self):
        p = os.path.join(self.history_dir, "LAST_GOOD")
        if os.path.exists(p):
            with open(p) as f:
                return f.read().strip()
        return None

    def history(self):
        good = self.last_good()
        out = []
        for d in sorted(os.listdir(self.history_dir), reverse=True):
            full = os.path.join(self.history_dir, d)
            if not os.path.isdir(full):
                continue
            reason = ""
            if os.path.exists(os.path.join(full, "REASON")):
                with open(os.path.join(full, "REASON"), encoding="utf-8") as f:
                    reason = f.read().strip()
            out.append({"id": d, "reason": reason, "good": d == good})
        return out

    def apply(self, machine, upload=True, log=None):
        """Zkontroluje, zazálohuje, vygeneruje a nahraje konfiguraci. Řízení musí stát."""
        log = log or (lambda m: None)
        with self.lock:
            if self.state not in ("stopped", "failed"):
                raise UserError("Nastavení stroje lze měnit jen při zastaveném řízení (Diagnostika → Zastavit).")
        m = configgen.normalize(machine)
        errors, warnings = configgen.validate(m)
        if errors:
            raise UserError("Nastavení obsahuje chyby: " + " ".join(errors))
        for w in warnings:
            log("Varování: " + w)
        old_json = self._read(os.path.join(self.machine_dir, "remora.json"))
        snap = self._snapshot("před uložením nového nastavení")
        if snap:
            log("Záloha předchozí konfigurace: %s" % snap)
        res = configgen.write_config(m, self.machine_dir, HEADLESS)
        log("Vygenerováno: remora.ini, remora.hal, remora.json (%d B)" % res["json_size"])
        if res["json_size"] > 7600:
            log("Varování: konfigurace desky má %d B, firmware 3.1.3 přijme max. ~7600 B." % res["json_size"])
        new_json = self._read(res["json"])
        if upload and new_json != old_json:
            log("Konfigurace desky se změnila, nahrávám do EC300…")
            self.board.upload_config(new_json, log)
        elif upload:
            log("Konfigurace desky beze změny, nenahrávám.")
        # nová konfigurace: před prvním spuštěním musí správce potvrdit kontrolu bezpečnosti
        with open(self.commission_flag, "w", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S"))
        log("Před prvním spuštěním potvrď kontrolu bezpečnostních obvodů (F5 Diagnostika → Spustit).")
        with self.lock:
            self.good_marked = False
        return {"warnings": warnings}

    def rollback(self, snap_id, log=None):
        src = os.path.join(self.history_dir, os.path.basename(snap_id))
        mj = os.path.join(src, "machine.json")
        if not os.path.exists(mj):
            raise UserError("Záloha neexistuje.")
        with open(mj, encoding="utf-8") as f:
            m = json.load(f)
        for extra in ("custom.hal", "tool.tbl"):
            if os.path.exists(os.path.join(src, extra)):
                shutil.copy2(os.path.join(src, extra), os.path.join(self.machine_dir, extra))
        return self.apply(m, upload=True, log=log)

    @staticmethod
    def _read(p):
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return f.read()
        return ""

    # ---------------------------------------------------------------- běh LinuxCNC

    def start(self):
        with self.lock:
            if self.state in ("starting", "running"):
                return
            if not self.is_configured():
                raise UserError("Stroj ještě není nastavený. Projdi průvodce v F1 Nastavení.")
            if self.commissioning_pending():
                raise UserError("Nastavení se změnilo: správce musí před spuštěním potvrdit kontrolu bezpečnosti.")
            self.error = ""
            self.state = "starting"
            self.started_at = time.time()
            self.good_marked = False
            self.board.stop_session()
            if self.demo:
                return
            log = open(self.log_path, "w", encoding="utf-8")
            self.proc = subprocess.Popen(["linuxcnc", self.ini_path], cwd=self.machine_dir,
                                         stdout=log, stderr=subprocess.STDOUT,
                                         start_new_session=True)

    def stop(self):
        with self.lock:
            if self.state in ("stopped", "failed"):
                return
            self.state = "stopping"
            if self.machine:
                try:
                    self.machine.command("estop", {})
                except Exception:
                    pass
                self.machine.close()
                self.machine = None
            if self.demo:
                self.state = "stopped"
                return
            proc = self.proc
        threading.Thread(target=self._stop_proc, args=(proc,), daemon=True).start()

    def _stop_proc(self, proc):
        # 1) ukončit headless displej -> LinuxCNC se sám korektně vypne
        try:
            with open(HEADLESS_PID) as f:
                os.kill(int(f.read().strip()), signal.SIGTERM)
        except (OSError, ValueError):
            pass
        try:
            if proc:
                proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=5)
            except Exception:
                pass
            subprocess.run(["halrun", "-U"], capture_output=True, timeout=20)
        with self.lock:
            self.proc = None
            self.state = "stopped"

    def restart(self):
        self.stop()
        deadline = time.time() + 30
        while self.state == "stopping" and time.time() < deadline:
            time.sleep(0.2)
        self.start()

    def get_machine(self):
        with self.lock:
            return self.machine if self.state == "running" else None

    def log_tail(self, lines=60):
        if self.demo:
            return "DEMO: LinuxCNC je simulované."
        try:
            with open(self.log_path, encoding="utf-8", errors="replace") as f:
                return "".join(f.readlines()[-lines:])
        except OSError:
            return ""

    def status(self):
        with self.lock:
            return {"state": self.state, "error": self.error, "configured": self.is_configured(),
                    "uptime": round(time.time() - self.started_at) if self.started_at and self.state == "running" else 0,
                    "last_good": self.last_good(), "demo": self.demo,
                    "commissioning": self.commissioning_pending()}

    def _monitor(self):
        while True:
            time.sleep(0.25)
            with self.lock:
                st = self.state
                proc = self.proc
            if st == "starting":
                if not self.demo and proc and proc.poll() is not None:
                    with self.lock:
                        self.state, self.error = "failed", "LinuxCNC se ukončilo při startu. Podívej se do logu."
                        self.proc = None
                    self.on_message("error", self.error)
                    continue
                try:
                    m = Machine(self.lc, self.hal, self.ini_path, self.on_message)
                    with self.lock:
                        self.machine = m
                        self.state = "running"
                        self.started_at = time.time()
                    self.on_message("info", "LinuxCNC běží.")
                except Exception:
                    if time.time() - (self.started_at or 0) > 60:
                        with self.lock:
                            self.state, self.error = "failed", "LinuxCNC nenaběhlo do 60 s."
                    continue
            elif st == "running":
                if not self.demo and proc and proc.poll() is not None:
                    with self.lock:
                        if self.machine:
                            self.machine.close()
                        self.machine = None
                        self.proc = None
                        self.state, self.error = "failed", "LinuxCNC neočekávaně skončilo."
                    self.on_message("error", self.error)
                    continue
                if not self.good_marked and time.time() - self.started_at > GOOD_AFTER_S:
                    m = self.get_machine()
                    ok = self.demo or (m is not None and m.hal_value("remora.status"))
                    if ok:
                        prev = self.last_good()
                        same = prev and self._read(os.path.join(self.history_dir, prev, "machine.json")) ==                             self._read(os.path.join(self.machine_dir, "machine.json"))
                        snap = None if same else self._snapshot("funkční konfigurace (LinuxCNC běží, deska odpovídá)")
                        if snap:
                            with open(os.path.join(self.history_dir, "LAST_GOOD"), "w") as f:
                                f.write(snap)
                        with self.lock:
                            self.good_marked = True
