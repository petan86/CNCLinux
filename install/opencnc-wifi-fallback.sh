#!/bin/bash
# OpenCNC Web: záložní Wi-Fi hotspot.
# Když se Pi nepřipojí k žádné známé Wi-Fi (nebo spojení vypadne déle než ~1 minutu),
# spustí vlastní hotspot (profil NetworkManageru "opencnc-ap", http://192.168.50.1/).
# Aktivní hotspot se sám nevypíná, aby se tablet neodpojil během obrábění.
# Na známou Wi-Fi se Pi vrátí po restartu.

AP="${AP:-opencnc-ap}"
IF="${IF:-wlan0}"
GRACE="${GRACE:-60}"     # čas po startu pro připojení ke známé síti
CHECK="${CHECK:-30}"     # interval kontroly
MISSES="${MISSES:-2}"    # kolik kontrol po sobě bez spojení, než se zapne hotspot

log() { logger -t opencnc-wifi "$*"; echo "$*"; }

nmcli -t -f NAME con show | grep -qx "$AP" || { log "Profil $AP neexistuje, končím."; exit 0; }

sleep "$GRACE"
miss=0
while true; do
    active="$(nmcli -t -f NAME,DEVICE con show --active | awk -F: -v d="$IF" '$2==d{print $1}')"
    if [ -n "$active" ]; then
        miss=0                                   # připojeno ke známé síti, nebo už běží hotspot
    else
        miss=$((miss + 1))
        if [ "$miss" -ge "$MISSES" ]; then
            log "Žádná známá Wi-Fi na $IF, zapínám záložní hotspot $AP."
            nmcli con up "$AP" >/dev/null 2>&1 && log "Hotspot $AP běží." || log "Hotspot $AP se nepodařilo zapnout."
            miss=0
        fi
    fi
    sleep "$CHECK"
done
