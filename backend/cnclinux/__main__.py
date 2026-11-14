"""
Spuštění:  python3 -m cnclinux [--data ~/cnclinux] [--port 8080] [--demo]

--demo   simulace LinuxCNC i desky EC300, funguje i na Windows/macOS bez stroje.
"""

import argparse
import os
import signal
import sys
import time

from .auth import Auth
from .board import Board, DemoBoard
from .runtime import Runtime
from .server import App, serve


def main():
    p = argparse.ArgumentParser(prog="cnclinux", description="OpenCNC Web - webové řízení CNC nad LinuxCNC a Remora")
    p.add_argument("--data", default=os.path.expanduser("~/cnclinux"), help="adresář s konfigurací stroje a daty")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8080)
    p.add_argument("--board-ip", default="10.10.10.10")
    p.add_argument("--demo", action="store_true", help="simulace bez LinuxCNC a bez desky")
    p.add_argument("--autostart", action="store_true", help="po startu spustit LinuxCNC, pokud je stroj nastavený")
    args = p.parse_args()

    os.makedirs(args.data, exist_ok=True)
    if args.demo:
        from . import demo_linuxcnc as lc
        hal = lc.hal
        board = DemoBoard(args.board_ip)
    else:
        try:
            import linuxcnc as lc
            import hal
        except ImportError:
            print("Modul linuxcnc není dostupný. Je nainstalované LinuxCNC? Pro zkoušku použij --demo.")
            sys.exit(1)
        board = Board(args.board_ip)

    holder = {}
    runtime = Runtime(args.data, board, lc, hal, demo=args.demo,
                      on_message=lambda k, t: holder["app"].message(k, t) if "app" in holder else None)
    app = App(runtime, board, Auth(os.path.join(args.data, "auth.json")), args.demo)
    holder["app"] = app
    if args.autostart and runtime.is_configured():
        try:
            runtime.start()
        except Exception as e:
            app.message("error", "Autostart LinuxCNC selhal: %s" % e)
    def on_term(signum, frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, on_term)
    try:
        serve(app, args.host, args.port)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        # korektně ukončit LinuxCNC (systemd stop, Ctrl+C)
        runtime.stop()
        deadline = time.time() + 30
        while runtime.status()["state"] == "stopping" and time.time() < deadline:
            time.sleep(0.2)


if __name__ == "__main__":
    main()
