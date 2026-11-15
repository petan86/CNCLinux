# OpenCNC Web

*(repozitář CNCLinux)*

Webové řízení CNC stroje postavené na **LinuxCNC 2.9** a firmwaru **Remora**.
Raspberry Pi 5 běží bez grafického prostředí. Ovládání i prvotní nastavení
stroje probíhá přes prohlížeč na tabletu, bez ruční úpravy souborů HAL a INI.

> **Experimentální verze.** Projekt zatím nebyl ověřen na skutečném stroji.
> Nepoužívej ho bez hardwarového E-stopu, který odpojí drivery nezávisle na
> Raspberry Pi a na softwaru.

## Co umí (v0.1)

Rozhraní je uspořádané jako průmyslový řídicí systém:

- **Nahoře:** stavový řádek a záložky F1–F6.
- **Vlevo:** 3D náhled drah s lištou aktivních G-kódů.
- **Vpravo:**
  - stavové dlaždice Připraven / Deska / E-stop;
  - velké souřadnice s tlačítkem NULA;
  - posuv, nástroj, vřeteno a strojní souřadnice;
  - ovládání podle záložky.

| Obrazovka | Funkce |
|---|---|
| **F1 Nastavení** | Menu sekcí: obecné, každá osa zvlášť (motor, převod, rychlost, softwarové limity, referování, časování STEP/DIR, test motoru), vřeteno, vstupy a výstupy EC300 s živým stavem svorek, řízení a deska, systém a test latence, aktualizace (systém, komponenta Remora, firmware EC300 přes SWD), zálohy s návratem k poslední funkční konfiguraci, heslo správce, kontrola a uložení s přehledem změn. Bez hesla jen pro čtení. |
| **F2 Program a MDI** | Výpis G-kódu s aktuálním řádkem a průběhem, korekce posuvu, rychloposuvu a vřetena, vřeteno M3/M4/M5, chlazení, najetí na nulu obrobku, spuštění od řádku, jeden blok, START / PAUZA / STOP, MDI. |
| **F3 Ruční posuv** | Krokový režim (1 / 0,5 / 0,1 / 0,01 mm) nebo plynulý s deadman signálem, rychlost, otočné osy, referování podržením tlačítka, zapnutí stroje. |
| **F4 Nástroje a offsety** | Tabulka nástrojů (délka, průměr, název), výměna M6 + G43, pracovní offsety G54–G59 s úpravou a aktivací. |
| **F5 Průvodci** | Programy bez CAM: zarovnání plochy, obdélníková kapsa, kruhová kapsa, vrtání v mřížce (G81/G83), s živým náhledem. |
| **F6 Soubory** | Nahrání G-kódu z tabletu, náhled drah, úprava v editoru, načtení do řízení, mazání. |

Ovládání stroje nevyžaduje přihlášení. Heslo správce chrání jen změny v F1, testy výstupů a motorů a aktualizace.
Klávesnice: F1–F6 přepínají obrazovky, Esc pozastaví běžící program.

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
frontend/           index.html, app.js, app.css, toolpath.js (3D náhled bez knihoven), wizards.js (průvodci F5)
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

Doporučená cesta je oficiální image LinuxCNC, ze kterého instalační skript udělá systém bez grafiky.

1. **Image.** Stáhni **LinuxCNC 2.9.x pro Raspberry Pi 4/5** (Debian 12 Bookworm, jádro PREEMPT_RT) z [linuxcnc.org/downloads](https://linuxcnc.org/downloads/). Nahraj ho v Raspberry Pi Imageru přes *Use custom* na SD kartu (min. 32 GB, A2) nebo NVMe.
2. **První spuštění.** Připoj Pi k monitoru, klávesnici a k domácí Wi-Fi. Ethernet nech volný, bude patřit EC300.
   ```
   sudo apt update && sudo apt -y upgrade
   sudo systemctl enable --now ssh
   uname -a        # musí obsahovat PREEMPT_RT
   ```
3. **Instalace OpenCNC Web:**
   ```
   sudo apt install -y git
   git clone https://github.com/petan86/CNCLinux.git
   cd CNCLinux
   sudo WIFI_MODE=hotspot WIFI_PASS=tvojeheslo ./install/install-pi5.sh
   sudo reboot
   ```
   Skript udělá tohle:
   - přepne Pi na start bez grafiky;
   - přeloží komponentu Remora;
   - připraví `eth0` pro EC300 (10.10.10.11/24);
   - nastaví Wi-Fi;
   - spustí službu `cnclinux` na portu 80.

   Síťová nastavení se zapnou až po restartu, takže instalace může běžet přes SSH.

   Volba Wi-Fi:
   - **`WIFI_MODE=hotspot`:** Pi vytvoří vlastní Wi-Fi `OpenCNC` (heslo min. 8 znaků). Tablet se připojí přímo k Pi, ale Pi pak nemá internet pro aktualizace.
   - **`WIFI_MODE=none`:** Pi zůstane v domácí nebo dílenské Wi-Fi a tablet se připojí přes ni.
4. **Zapojení.** Po restartu propoj Pi a EC300 ethernetovým kabelem (EC300 má 10.10.10.10).
5. **Tablet.** Otevři `http://192.168.50.1/` (hotspot) nebo `http://<název-pi>.local/` (domácí Wi-Fi). V F1 nastav heslo správce a projdi sekce shora dolů.
6. **Před prvním pohybem:**
   - F1 → Systém a latence: RT jádro „ano“, latence pod 100 µs.
   - F1 → Řízení a deska: deska odpovídá.
   - F1 → Vstupy a výstupy: E-stop a koncové spínače reagují.
   - V sekcích os proveď test motoru, nejdřív bez mechanické zátěže.

Jiné cesty, například Raspberry Pi OS Lite s vlastním RT jádrem nebo Debian na PC (x86), zatím nejsou otestované.

### Firmware EC300

EC300 musí mít firmware Remora-RT1052 3.1.x. Podrobný návod se schématem zapojení
Raspberry Pi Pico je v [docs/flash-ec300.md](docs/flash-ec300.md). Ve zkratce:

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
| v0.1 | Headless LinuxCNC, rozhraní F1–F6, konfigurátor, diagnostika, jog, G-kód, 3D náhled, průvodci (tato verze, experimentální) |
| v0.2 | Ověření na stroji s EC300, ruční výměna nástroje s dialogem, sondování, WebSocket místo dotazování, další průvodci (profil, závit) |
| v0.3 | Další desky (EC500, Mesa), osa C a gantry (dva motory na osu), instalace na Raspberry Pi OS Lite a Debian na PC |

## Licence

OpenCNC Web je svobodný software pod licencí **GPL-2.0-or-later** (viz [LICENSE](LICENSE)),
kompatibilní s LinuxCNC (GPL-2.0) i s firmwarem Remora (GPL-3.0).

- `hal/remora-eth-3.0.c` je upravená komponenta z projektu Remora (Scott Alford), GPL-2.0.
- `firmware/remora-rt1052-fixes.patch` je změna firmwaru Remora-RT1052, a proto spadá pod jeho licenci GPL-3.0.
