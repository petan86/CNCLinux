"""
Přímá komunikace s deskou Remora (EC300) přes UDP, bez LinuxCNC.

Používá se jen když LinuxCNC neběží:
  - zjištění, jestli deska odpovídá (a jak rychle)
  - čtení vstupů a test výstupů / PWM vřetena / motoru při prvním nastavení
  - nahrání konfigurace firmwaru přes TFTP

Protokol odpovídá firmwaru Remora-RT1052 3.x (source/remora.h, ethernet.cpp):
  PRU_READ  -> odpověď PRU_DATA (64 B): header, 6× poloha, 4× float, uint32 vstupy, uint16 NVMPG
  PRU_WRITE -> odpověď PRU_ACKNOWLEDGE: header, 6× frekvence, 4× float, uint8 enable, uint32 výstupy
Firmware sám vynuluje výstupy a zastaví kroky, když 5 ms nedostane paket,
takže test motoru je přirozeně "deadman".
"""

import binascii
import math
import socket
import struct
import threading
import time

PORT = 27181
PRU_DATA = 0x64617461
PRU_READ = 0x72656164
PRU_WRITE = 0x77726974
PRU_ACKNOWLEDGE = 0x61636B6E
JOINTS = 6
VARIABLES = 4

RX_FMT = "<i6i4fIH"        # 50 B užitečných dat z 64 B bufferu
TX_FMT = "<i6i4fBIB"       # 50 B
KEEPALIVE_S = 0.002        # 2 ms, firmware zastaví vše po 5 ms bez paketu
SESSION_TIMEOUT_S = 2.0    # test I/O skončí, když se UI 2 s neozve
MOTOR_DEADMAN_S = 0.4      # motor stojí, když tablet 0,4 s nepotvrdí držení tlačítka
MOTOR_MAX_HZ = 5000        # test motoru jen pomalu


class BoardError(Exception):
    pass


class Board:
    def __init__(self, ip="10.10.10.10"):
        self.ip = ip
        self.lock = threading.RLock()
        self.session = None          # aktivní test I/O
        self.thread = None
        self.last = {"ok": False, "rtt_ms": None, "inputs": 0, "counts": [0] * JOINTS, "t": 0}

    # ---------- jednorázové čtení ----------

    def _socket(self, timeout=0.05):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(timeout)
        return s

    def probe(self, tries=3):
        """Pošle PRU_READ, vrátí stav desky (ok, rtt, vstupy, počty kroků)."""
        with self.lock:
            if self.session:
                return dict(self.last)
            s = self._socket(0.1)
            try:
                for _ in range(tries):
                    t0 = time.perf_counter()
                    try:
                        s.sendto(struct.pack("<i", PRU_READ), (self.ip, PORT))
                        data, _ = s.recvfrom(128)
                    except (socket.timeout, OSError):
                        continue
                    rtt = (time.perf_counter() - t0) * 1000
                    parsed = self._parse(data)
                    if parsed:
                        self.last = dict(parsed, ok=True, rtt_ms=round(rtt, 3), t=time.time())
                        return dict(self.last)
                self.last = dict(self.last, ok=False, rtt_ms=None, t=time.time())
                return dict(self.last)
            finally:
                s.close()

    @staticmethod
    def _parse(data):
        if len(data) < struct.calcsize(RX_FMT):
            return None
        v = struct.unpack_from(RX_FMT, data)
        if v[0] != PRU_DATA:
            return None
        return {"counts": list(v[1:7]), "pv": list(v[7:11]), "inputs": v[11], "nvmpg": v[12]}

    # ---------- test I/O s keepalive ----------

    def start_session(self):
        with self.lock:
            if self.session is None:
                self.session = {"outputs": 0, "pwm": 0.0, "freq": [0] * JOINTS, "enable": 0,
                                "touched": time.monotonic(), "motor_touched": 0.0, "errors": 0}
                self.thread = threading.Thread(target=self._run, daemon=True)
                self.thread.start()
            else:
                self.session["touched"] = time.monotonic()

    def stop_session(self):
        with self.lock:
            self.session = None

    def set_output(self, bit, value):
        self.start_session()
        with self.lock:
            if value:
                self.session["outputs"] |= (1 << bit)
            else:
                self.session["outputs"] &= ~(1 << bit)

    def set_pwm(self, percent):
        self.start_session()
        with self.lock:
            self.session["pwm"] = max(0.0, min(100.0, float(percent)))

    def motor(self, joint, freq):
        """freq v Hz se znaménkem; 0 = stop. Volat opakovaně, jinak se motor zastaví."""
        self.start_session()
        with self.lock:
            freq = int(max(-MOTOR_MAX_HZ, min(MOTOR_MAX_HZ, freq)))
            self.session["freq"] = [0] * JOINTS
            self.session["freq"][joint] = freq
            self.session["enable"] = (1 << joint) if freq else 0
            self.session["motor_touched"] = time.monotonic()

    def session_state(self):
        with self.lock:
            sess = self.session
            out = dict(self.last)
            out["session"] = bool(sess)
            if sess:
                sess["touched"] = time.monotonic()
                out.update(outputs=sess["outputs"], pwm=sess["pwm"], freq=list(sess["freq"]))
            return out

    def _run(self):
        s = self._socket(0.02)
        next_read = 0.0
        try:
            while True:
                with self.lock:
                    sess = self.session
                    if sess is None:
                        break
                    now = time.monotonic()
                    if now - sess["touched"] > SESSION_TIMEOUT_S:
                        self.session = None
                        break
                    if now - sess["motor_touched"] > MOTOR_DEADMAN_S:
                        sess["freq"] = [0] * JOINTS
                        sess["enable"] = 0
                    pwm = [sess["pwm"], 0.0, 0.0, 0.0]
                    pkt = struct.pack(TX_FMT, PRU_WRITE, *sess["freq"], *pwm, sess["enable"], sess["outputs"], 0)
                try:
                    s.sendto(pkt.ljust(64, b"\0"), (self.ip, PORT))
                    s.recvfrom(128)                        # PRU_ACKNOWLEDGE
                    if now >= next_read:
                        next_read = now + 0.02
                        t0 = time.perf_counter()
                        s.sendto(struct.pack("<i", PRU_READ), (self.ip, PORT))
                        data, _ = s.recvfrom(128)
                        parsed = self._parse(data)
                        if parsed:
                            with self.lock:
                                self.last = dict(parsed, ok=True, t=time.time(),
                                                 rtt_ms=round((time.perf_counter() - t0) * 1000, 3))
                except (socket.timeout, OSError):
                    with self.lock:
                        if self.session:
                            self.session["errors"] += 1
                        self.last = dict(self.last, ok=False, rtt_ms=None, t=time.time())
                time.sleep(KEEPALIVE_S)
        finally:
            s.close()

    # ---------- TFTP upload konfigurace ----------

    def upload_config(self, text, log=None):
        """Nahraje JSON konfiguraci do firmwaru (stejný formát jako upload_config.py).
        Deska po přijetí zkontroluje CRC, uloží konfiguraci a restartuje se."""
        self.stop_session()
        log = log or (lambda m: None)
        config = text.encode("utf-8")
        json_len = len(config)
        words = math.ceil(json_len / 4)
        if json_len % 4:
            config += b"\0" * (4 - json_len % 4)
        crc = binascii.crc32(config) & 0xFFFFFFFF
        meta = struct.pack("<III", crc, words, json_len).ljust(512, b"\0")
        payload = meta + config
        log("Konfigurace %d B, CRC32 %08x, odesílám přes TFTP na %s" % (json_len, crc, self.ip))
        tftp_put(self.ip, payload, "config")
        log("Odesláno. Deska ukládá konfiguraci a restartuje se.")
        # počkat na restart desky
        time.sleep(1.0)
        deadline = time.time() + 15
        while time.time() < deadline:
            st = self.probe(1)
            if st["ok"]:
                log("Deska znovu odpovídá (%.2f ms)." % st["rtt_ms"])
                return True
            time.sleep(0.5)
        raise BoardError("Deska po nahrání konfigurace neodpovídá.")


def tftp_put(host, data, filename, timeout=3.0, retries=5):
    """Minimální TFTP klient (RFC 1350, režim octet), jen zápis."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        wrq = b"\x00\x02" + filename.encode() + b"\x00octet\x00"
        peer = None
        for _ in range(retries):
            s.sendto(wrq, (host, 69))
            try:
                pkt, addr = s.recvfrom(516)
            except socket.timeout:
                continue
            if pkt[:2] == b"\x00\x05":
                raise BoardError("TFTP chyba: %s" % pkt[4:].split(b"\0")[0].decode(errors="replace"))
            if pkt[:4] == b"\x00\x04\x00\x00":
                peer = addr
                break
        if peer is None:
            raise BoardError("Deska nepotvrdila TFTP zápis (je zapnutá a na %s?)." % host)

        blocks = [data[i:i + 512] for i in range(0, len(data), 512)]
        if len(data) % 512 == 0:
            blocks.append(b"")
        for n, chunk in enumerate(blocks, start=1):
            pkt_out = b"\x00\x03" + struct.pack(">H", n & 0xFFFF) + chunk
            for attempt in range(retries):
                s.sendto(pkt_out, peer)
                try:
                    pkt, addr = s.recvfrom(516)
                except socket.timeout:
                    continue
                if addr != peer:
                    continue
                if pkt[:2] == b"\x00\x05":
                    raise BoardError("TFTP chyba: %s" % pkt[4:].split(b"\0")[0].decode(errors="replace"))
                if pkt[:2] == b"\x00\x04" and struct.unpack(">H", pkt[2:4])[0] == (n & 0xFFFF):
                    break
            else:
                raise BoardError("TFTP: blok %d nebyl potvrzen." % n)
    finally:
        s.close()


class DemoBoard(Board):
    """Simulace desky pro --demo."""

    def __init__(self, ip="10.10.10.10"):
        super().__init__(ip)
        self._counts = [0] * JOINTS
        self._t = time.monotonic()

    def probe(self, tries=3):
        with self.lock:
            self._tick()
            phase = int(time.time() / 2)
            inputs = (1 << 23) | ((1 << (4 + phase % 4)))
            self.last = {"ok": True, "rtt_ms": 0.18, "inputs": inputs, "counts": list(self._counts),
                         "pv": [0, 0, 0, 0], "nvmpg": 0, "t": time.time()}
            return dict(self.last)

    def _tick(self):
        now = time.monotonic()
        dt, self._t = now - self._t, now
        if self.session:
            if now - self.session["motor_touched"] > MOTOR_DEADMAN_S:
                self.session["freq"] = [0] * JOINTS
            for j in range(JOINTS):
                self._counts[j] += int(self.session["freq"][j] * dt)
            if now - self.session["touched"] > SESSION_TIMEOUT_S:
                self.session = None

    def start_session(self):
        with self.lock:
            if self.session is None:
                self.session = {"outputs": 0, "pwm": 0.0, "freq": [0] * JOINTS, "enable": 0,
                                "touched": time.monotonic(), "motor_touched": 0.0, "errors": 0}
            self.session["touched"] = time.monotonic()

    def session_state(self):
        self.probe()
        return super().session_state()

    def upload_config(self, text, log=None):
        log = log or (lambda m: None)
        log("DEMO: konfigurace %d B by se nahrála na %s přes TFTP." % (len(text), self.ip))
        time.sleep(0.5)
        log("DEMO: deska odpovídá.")
        return True
