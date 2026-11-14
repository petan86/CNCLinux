#!/bin/bash
# OpenCNC Web - instalace na Raspberry Pi 5
#
# Předpoklad: oficiální image LinuxCNC 2.9 pro Raspberry Pi 4/5
# (Debian 12 bookworm, arm64, jádro PREEMPT_RT) z https://linuxcnc.org/downloads/
#
# Použití (z adresáře repozitáře):
#   sudo ./install/install-pi5.sh
# Volby přes proměnné prostředí:
#   WIFI_MODE=hotspot|none   (výchozí hotspot: Pi vytvoří Wi-Fi síť pro tablet)
#   WIFI_SSID=OpenCNC  WIFI_PASS=<heslo, min. 8 znaků>
#   ETH_IF=eth0              rozhraní k EC300
#   HTTP_PORT=80
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="${SUDO_USER:-$(logname 2>/dev/null || echo pi)}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
WIFI_MODE="${WIFI_MODE:-hotspot}"
WIFI_SSID="${WIFI_SSID:-OpenCNC}"
ETH_IF="${ETH_IF:-eth0}"
HTTP_PORT="${HTTP_PORT:-80}"

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mCHYBA: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Spusť přes sudo."
[ "$(uname -m)" = "aarch64" ] || echo "Varování: nejde o arm64 ($(uname -m)), skript je psaný pro Raspberry Pi 5."
dpkg -s linuxcnc-uspace >/dev/null 2>&1 || die "LinuxCNC není nainstalované. Použij oficiální image LinuxCNC pro Raspberry Pi."
uname -v | grep -q "PREEMPT_RT\|PREEMPT RT" || echo "Varování: jádro není PREEMPT_RT, real-time výkon nebude dostatečný."

say "Balíčky (hlavičky pro halcompile, cyclictest, NetworkManager)"
apt-get update
apt-get install -y linuxcnc-uspace-dev rt-tests python3 network-manager avahi-daemon

say "Bez grafického prostředí (boot do konzole)"
systemctl set-default multi-user.target

say "Komponenta Remora pro LinuxCNC"
halcompile --install "$REPO/hal/remora-eth-3.0.c"

say "Ethernet $ETH_IF pro EC300: 10.10.10.11/24"
nmcli -t -f NAME con show | grep -qx ec300 && nmcli con delete ec300 >/dev/null
nmcli con add type ethernet ifname "$ETH_IF" con-name ec300 \
    ipv4.method manual ipv4.addresses 10.10.10.11/24 ipv4.never-default yes ipv6.method disabled \
    connection.autoconnect yes >/dev/null
nmcli con up ec300 >/dev/null || echo "  (EC300 zatím není připojená, spojení naběhne po připojení kabelu)"

if [ "$WIFI_MODE" = "hotspot" ]; then
    say "Wi-Fi hotspot '$WIFI_SSID' pro tablet"
    if [ -z "${WIFI_PASS:-}" ]; then
        WIFI_PASS="$(tr -dc 'a-km-np-z2-9' </dev/urandom | head -c 10)"
    fi
    nmcli -t -f NAME con show | grep -qx cnclinux-ap && nmcli con delete cnclinux-ap >/dev/null
    nmcli con add type wifi ifname wlan0 con-name cnclinux-ap autoconnect yes ssid "$WIFI_SSID" \
        802-11-wireless.mode ap 802-11-wireless.band bg ipv4.method shared ipv4.addresses 192.168.50.1/24 \
        wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$WIFI_PASS" >/dev/null
    nmcli con up cnclinux-ap >/dev/null || echo "  (hotspot se spustí po restartu)"
fi

say "Oprávnění (sudoers) pro aktualizace a test latence"
sed "s/@USER@/$USER_NAME/g" "$REPO/install/cnclinux.sudoers" > /etc/sudoers.d/cnclinux
chmod 440 /etc/sudoers.d/cnclinux
visudo -cf /etc/sudoers.d/cnclinux >/dev/null || { rm -f /etc/sudoers.d/cnclinux; die "Neplatný soubor sudoers."; }

say "Služba cnclinux (webové rozhraní na portu $HTTP_PORT)"
chmod +x "$REPO/backend/cnclinux/headless.py"
sed -e "s|@USER@|$USER_NAME|g" -e "s|@HOME@|$USER_HOME|g" -e "s|@REPO@|$REPO|g" -e "s|@PORT@|$HTTP_PORT|g" \
    "$REPO/install/cnclinux.service" > /etc/systemd/system/cnclinux.service
systemctl daemon-reload
systemctl enable --now cnclinux.service

say "Výkon CPU: governor performance"
cat > /etc/systemd/system/cpu-performance.service <<'EOF'
[Unit]
Description=CPU governor performance pro LinuxCNC
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'for g in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo performance > $g; done'
[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now cpu-performance.service

IP_WIFI="192.168.50.1"
echo
echo "Hotovo."
echo "  Webové rozhraní:  http://$(hostname).local$( [ "$HTTP_PORT" = 80 ] || echo ":$HTTP_PORT")/"
[ "$WIFI_MODE" = "hotspot" ] && echo "  Wi-Fi pro tablet: $WIFI_SSID / heslo: $WIFI_PASS  ->  http://$IP_WIFI$( [ "$HTTP_PORT" = 80 ] || echo ":$HTTP_PORT")/"
echo "  EC300:            10.10.10.10 na $ETH_IF (Pi má 10.10.10.11)"
echo "  Volitelně flash EC300 z Pi:  sudo -u $USER_NAME pipx install pyocd"
echo "  Doporučení: restartuj Pi (sudo reboot), pak otevři webové rozhraní a nastav heslo správce."
