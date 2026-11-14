"""
Diagnostika systému a aktualizace (běží na Raspberry Pi 5).

Příkazy vyžadující root se volají přes sudo a jsou povolené jen ty,
které vyjmenovává install/cnclinux.sudoers.
"""

import glob
import os
import platform
import re
import shutil
import subprocess
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
HAL_COMPONENT = os.path.join(REPO, "hal", "remora-eth-3.0.c")


def _run(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return -1, str(e)


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def info(demo=False):
    if demo:
        return {"host": "demo", "kernel": "6.6.x-rt (simulace)", "rt": True, "cpu_temp": 48.2,
                "load": [0.4, 0.3, 0.2], "mem_used_pct": 21, "disk_free_gb": 18.4, "uptime_h": 1.2,
                "linuxcnc": "2.9.x (simulace)", "remora_component": True, "pyocd": False,
                "model": "Raspberry Pi 5 (simulace)",
                "interfaces": [{"name": "eth0", "addr": "10.10.10.11/24"}, {"name": "wlan0", "addr": "192.168.4.1/24"}]}
    uname = platform.uname()
    temp = _read("/sys/class/thermal/thermal_zone0/temp")
    mem = {}
    for line in (_read("/proc/meminfo") or "").splitlines():
        k, _, v = line.partition(":")
        mem[k] = int(v.split()[0]) if v.split() else 0
    du = shutil.disk_usage(os.path.expanduser("~"))
    ifaces = []
    code, out = _run(["ip", "-4", "-o", "addr", "show"])
    for line in out.splitlines() if code == 0 else []:
        parts = line.split()
        if len(parts) > 3 and parts[1] != "lo":
            ifaces.append({"name": parts[1], "addr": parts[3]})
    code, ver = _run(["dpkg-query", "-W", "-f=${Version}", "linuxcnc-uspace"])
    comps = glob.glob("/usr/lib/linuxcnc/modules/remora-eth-3.0.so") + \
        glob.glob("/usr/lib/*/linuxcnc/modules/remora-eth-3.0.so")
    return {
        "host": uname.node, "kernel": uname.release + " " + uname.version,
        "rt": "PREEMPT_RT" in uname.version or "PREEMPT RT" in uname.version,
        "cpu_temp": round(int(temp) / 1000, 1) if temp and temp.isdigit() else None,
        "load": list(os.getloadavg()),
        "mem_used_pct": round(100 * (1 - mem.get("MemAvailable", 0) / max(mem.get("MemTotal", 1), 1))),
        "disk_free_gb": round(du.free / 1e9, 1),
        "uptime_h": round(float((_read("/proc/uptime") or "0").split()[0]) / 3600, 1),
        "linuxcnc": ver if code == 0 else "nenainstalováno",
        "remora_component": bool(comps),
        "pyocd": shutil.which("pyocd") is not None,
        "model": (_read("/proc/device-tree/model") or "").strip("\x00"),
        "interfaces": ifaces,
    }


class Jobs:
    """Dlouhé úlohy (test latence, aktualizace, flash) běží na pozadí, UI čte jejich log."""

    def __init__(self):
        self.lock = threading.Lock()
        self.jobs = {}
        self.seq = 0

    def start(self, title, fn):
        with self.lock:
            if any(j["running"] for j in self.jobs.values()):
                raise RuntimeError("Už běží jiná úloha, počkej na její dokončení.")
            self.seq += 1
            jid = str(self.seq)
            job = {"id": jid, "title": title, "running": True, "ok": None, "log": [], "result": None,
                   "started": time.time()}
            self.jobs[jid] = job

        def log(line):
            with self.lock:
                job["log"].append(str(line))
                del job["log"][:-400]

        def runner():
            try:
                job["result"] = fn(log)
                job["ok"] = True
            except Exception as e:
                log("CHYBA: %s" % e)
                job["ok"] = False
            finally:
                job["running"] = False

        threading.Thread(target=runner, daemon=True).start()
        return jid

    def get(self, jid=None):
        with self.lock:
            if jid is None:
                if not self.jobs:
                    return None
                jid = max(self.jobs, key=int)
            j = self.jobs.get(jid)
            return dict(j, log=list(j["log"])) if j else None


def stream(cmd, log, timeout=3600):
    log("$ " + " ".join(cmd))
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    t0 = time.time()
    for line in p.stdout:
        log(line.rstrip())
        if time.time() - t0 > timeout:
            p.kill()
            raise RuntimeError("Příkaz trval příliš dlouho.")
    p.wait()
    if p.returncode != 0:
        raise RuntimeError("Příkaz skončil s kódem %d." % p.returncode)


def latency_test(log, seconds=60, demo=False):
    """cyclictest na izolovaném jádře; výsledek v µs. Pro LinuxCNC se servo threadem 1 ms
    je do ~100 µs v pořádku, do ~50 µs výborné."""
    if demo:
        for i in range(5):
            log("DEMO: měřím… %d s" % (i + 1)); time.sleep(0.4)
        log("Max latence: 38 µs")
        return {"max_us": 38}
    cmd = ["sudo", "-n", "/usr/bin/cyclictest", "-m", "-S", "-p90", "-i200", "-q", "-D", "%ds" % seconds]
    log("Měřím latenci %d s (cyclictest). Během testu stroj neovládej." % seconds)
    lines = []
    stream(cmd, lambda l: (lines.append(l), log(l)), timeout=seconds + 30)
    maxes = [int(x) for l in lines for x in re.findall(r"Max:\s*(\d+)", l)]
    if not maxes:
        raise RuntimeError("Výstup cyclictestu se nepodařilo přečíst.")
    worst = max(maxes)
    log("Nejhorší latence: %d µs (%s)" % (worst, "výborné" if worst < 50 else "v pořádku" if worst < 100 else "vysoké, ověř RT jádro a vypni úsporu energie"))
    return {"max_us": worst}


def check_updates(log, demo=False):
    if demo:
        log("DEMO: kontrola aktualizací"); time.sleep(0.5)
        return {"packages": ["linuxcnc-uspace 2.9.x"]}
    stream(["sudo", "-n", "/usr/bin/apt-get", "update"], log, timeout=600)
    code, out = _run(["apt", "list", "--upgradable"], timeout=60)
    pkgs = [l.split("/")[0] for l in out.splitlines() if "/" in l]
    log("K aktualizaci: %d balíčků%s" % (len(pkgs), (" (LinuxCNC: ano)" if any("linuxcnc" in p for p in pkgs) else "")))
    return {"packages": pkgs}


def upgrade_system(log, demo=False):
    if demo:
        log("DEMO: apt-get upgrade"); time.sleep(1)
        return {}
    stream(["sudo", "-n", "/usr/bin/apt-get", "-y", "upgrade"], log, timeout=3600)
    log("Hotovo. Po aktualizaci LinuxCNC je potřeba znovu přeložit komponentu Remora.")
    return {}


def install_hal_component(log, demo=False):
    if demo:
        log("DEMO: halcompile --install remora-eth-3.0.c"); time.sleep(0.5)
        return {}
    if not os.path.exists(HAL_COMPONENT):
        raise RuntimeError("Chybí %s" % HAL_COMPONENT)
    stream(["sudo", "-n", "/usr/bin/halcompile", "--install", HAL_COMPONENT], log, timeout=600)
    return {}


def flash_firmware(log, bin_path, demo=False):
    """Nahraje firmware do EC300 přes SWD programátor (Raspberry Pi Pico s debugprobe) připojený k Pi."""
    if demo:
        log("DEMO: pyocd flash %s" % os.path.basename(bin_path)); time.sleep(1)
        return {}
    if not shutil.which("pyocd"):
        raise RuntimeError("pyOCD není nainstalované (pip install pyocd).")
    stream(["pyocd", "list"], log, timeout=60)
    stream(["pyocd", "flash", "-t", "mimxrt1050_quadspi", "-f", "1M", "--base-address", "0x60000000", bin_path],
           log, timeout=600)
    log("Firmware nahrán. Vypni a zapni EC300, pak v Nastavení ulož konfiguraci znovu (nahraje se do desky).")
    return {}


def power(action, demo=False):
    if demo:
        return
    if action == "reboot":
        subprocess.Popen(["sudo", "-n", "/usr/sbin/reboot"])
    elif action == "poweroff":
        subprocess.Popen(["sudo", "-n", "/usr/sbin/poweroff"])
