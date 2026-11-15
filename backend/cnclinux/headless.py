#!/usr/bin/env python3
"""
Headless "displej" pro LinuxCNC.

LinuxCNC vyžaduje v [DISPLAY]DISPLAY program, který běží po celou dobu řízení.
Tento program nic nezobrazuje: jen čeká, dokud ho OpenCNC Web neukončí (SIGTERM).
Po jeho skončení LinuxCNC korektně vypne HAL a real-time část.
"""

import os
import signal
import sys
import time

PID_FILE = "/tmp/cnclinux-headless.pid"


def main():
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))
    running = [True]

    def stop(signum, frame):
        running[0] = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print("OpenCNC Web headless display běží (ovládání přes web).", flush=True)
    try:
        while running[0]:
            time.sleep(0.5)
    finally:
        try:
            os.remove(PID_FILE)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
