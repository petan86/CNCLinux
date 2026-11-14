# OpenCNC Web

*(repozitář CNCLinux)*

Webové řízení CNC stroje postavené na **LinuxCNC 2.9** a firmwaru **Remora**.
Raspberry Pi 5 běží bez grafického prostředí. Ovládání i prvotní nastavení
stroje probíhá přes prohlížeč na tabletu, bez ruční úpravy souborů HAL a INI.

> **Experimentální verze.** Projekt zatím nebyl ověřen na skutečném stroji.
> Nepoužívej ho bez hardwarového E-stopu, který odpojí drivery nezávisle na
> Raspberry Pi a na softwaru.

## Co umí (v0.1)

| Obrazovka | Funkce |
|---|---|
| **F1 Nastavení** (správce) | Průvodce v 5 krocích: osy, motory (kroky, mikrokroky, stoupání, časování STEP/DIR), dráha a referování, přiřazení vstupů a výstupů EC300 s živým stavem svorek, vřeteno. Kontrola konfliktů a frekvence kroků, přehled změn, náhled vygenerovaných souborů, zálohy a návrat k poslední funkční konfiguraci, aktualizace, hesla. |
| **F2 Běh** | Velké DRO, 3D náhled drah s průběhem obrábění a polohou nástroje, start, pauza, krok, stop, override posuvu, rychloposuvu a vřetena. |
| **F3 Jog** | Plynulý jog s deadman signálem nebo krokování 0,01–10 mm, referování, nulové body, G54–G59, MDI s historií. |
| **F4 Nástroje** | Tabulka nástrojů, výměna M6 + G43. |
| **F5 Diagnostika** | Spuštění a zastavení LinuxCNC, stav desky a odezva, živé vstupy, test výstupů a PWM, test motoru bez LinuxCNC, test latence, informace o Pi, log. |
| **F6 Soubory** | Nahrání G-kódu z tabletu, náhled, načtení do řízení. |

Bezpečnostní zásady v kódu:

- Webová aplikace není součástí real-time smyčky. Pohyb počítá LinuxCNC a kroky generuje deska.
- Plynulý jog i test motoru se zastaví, když tablet 0,4 s nepotvrdí držení tlačítka (výpadek Wi-Fi).
- Nastavení ovlivňující pohyb lze měnit jen při zastaveném řízení.
- Uložení nastavení samo nepovolí pohyb: první spuštění nové konfigurace musí správce potvrdit po kontrole bezpečnostních obvodů.
- Testy výstupů a motoru jdou jen při zastaveném LinuxCNC a jen pro správce.

## Architektura

```
Tablet (prohlížeč)  ──Wi-Fi──  Raspberry Pi 5  ──Ethernet──  EC300 (i.MX RT1052, Remora)
                               ├─ CNC Web Manager  (backend/cnclinux, Python)
                               │    REST API, přihlášení, generátor konfigurace,
                               │    diagnostika, správa LinuxCNC
                               └─ CNC Runtime      (LinuxCNC 2.9 + remora-eth-3.0)
                                    headless displej, servo thread 1 ms
```

- **CNC Runtime:** LinuxCNC se spouští s headless displejem (`backend/cnclinux/headless.py`) a webová správa ho spouští a zastavuje. Díky tomu nastavení, diagnostika a aktualizace fungují i bez běžícího řízení.
- **Generátor konfigurace** (`configgen.py`): z jednoho `machine.json` vytvoří `remora.ini`, `remora.hal` a `remora.json` (konfiguraci firmwaru, nahrává se do desky přes TFTP). Vlastní úpravy HAL patří do `custom.hal`, ten se nepřepisuje.
- **Přímá komunikace s deskou** (`board.py`): při zastaveném LinuxCNC čte vstupy a testuje výstupy přes UDP protokol Remory. Firmware sám zastaví vše po 5 ms bez paketu.

```
backend/cnclinux/   server (REST), runtime (LinuxCNC), configgen, board (UDP/TFTP), system, auth, demo
frontend/           index.html, app.js, app.css, toolpath.js (3D náhled bez knihoven)
hal/                remora-eth-3.0.c s opravami (viz firmware/)
firmware/           patch oprav firmwaru Remora-RT1052
install/            instalace pro Raspberry Pi 5, systemd služba, sudoers
```

Backend používá jen standardní knihovnu Pythonu a frontend nemá žádné závislosti.
Na Pi tak není potřeba nic doinstalovávat přes pip a rozhraní funguje i v dílně bez internetu.

## Vyzkoušení bez stroje

Simulace LinuxCNC i desky EC300, funguje i na Windows a macOS:

```
cd backend
python3 -m cnclinux --demo --port 8080 --data ./demo-data
```

Pak otevři `http://localhost:8080/`.

## Instalace na Raspberry Pi 5

1. Nahraj na SD kartu nebo NVMe **oficiální image LinuxCNC 2.9 pro Raspberry Pi 4/5** (Debian 12, jádro PREEMPT_RT) z [linuxcnc.org/downloads](https://linuxcnc.org/downloads/).
2. Propoj Pi a EC300 ethernetovým kabelem. Pi má adresu 10.10.10.11, EC300 má 10.10.10.10.
3. Spusť instalaci:
   ```
   git clone https://github.com/petan86/CNCLinux.git
   cd CNCLinux
   sudo WIFI_PASS=tajneheslo ./install/install-pi5.sh
   sudo reboot
   ```
   Skript přepne Pi na start bez grafiky, přeloží komponentu Remora, nastaví `eth0` pro EC300, vytvoří Wi-Fi hotspot `OpenCNC` pro tablet a spustí službu `cnclinux`.
4. Na tabletu se připoj k Wi-Fi `OpenCNC`, otevři `http://192.168.50.1/`, nastav heslo správce a projdi průvodce v F1.

### Firmware EC300

EC300 musí mít firmware Remora-RT1052 3.1.x. Postup:

- Nahraj ho přes SWD, například Raspberry Pi Pico s firmwarem debugprobe a pyOCD (target `mimxrt1050_quadspi`, adresa `0x60000000`).
- Při prvním nahrání smaž celou flash (`-e chip`), aby v ní nezůstala data původního Mach3 firmwaru.
- Když je Pico připojené k Raspberry Pi, jde firmware nahrát i z F1 → Aktualizace.

Opravy v [firmware/](firmware/) doporučuji: přetečení bufferu UDP, větší oblast pro konfiguraci, směr osy C v DMA stepgenu a filtr zpětné vazby nad 250 kHz.

## Podporovaný hardware

| Část | Stav |
|---|---|
| Raspberry Pi 5 + LinuxCNC 2.9 (PREEMPT_RT) | cílová platforma |
| EC300 (i.MX RT1052) + Remora 3.1.x | podporováno, DMA stepgen až 500 kHz, 6 os, 27 vstupů, 10 výstupů, PWM 0–10 V |
| EC500, NVEM, Mesa, další desky Remora | plánováno (generátor konfigurace je připravený na další definice desek) |

## Plán

| Verze | Obsah |
|---|---|
| v0.1 | Headless LinuxCNC, webový dashboard, souřadnice, diagnostika, konfigurátor, jog, G-kód a 2D/3D náhled (tato verze, experimentální) |
| v0.2 | Ověření na stroji s EC300, ruční výměna nástroje s dialogem, sondování, WebSocket místo dotazování |
| v0.3 | Další desky (EC500, Mesa), osa C a gantry (dva motory na osu), konverzační průvodci |

## Licence

OpenCNC Web je svobodný software pod licencí **GPL-2.0-or-later** (viz [LICENSE](LICENSE)),
kompatibilní s LinuxCNC (GPL-2.0) i s firmwarem Remora (GPL-3.0).

- `hal/remora-eth-3.0.c` je upravená komponenta z projektu Remora (Scott Alford), GPL-2.0.
- `firmware/remora-rt1052-fixes.patch` je změna firmwaru Remora-RT1052, a proto spadá pod jeho licenci GPL-3.0.
