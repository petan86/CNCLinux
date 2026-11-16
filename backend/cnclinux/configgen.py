"""
Generátor konfigurace stroje.

Z jednoho souboru machine.json (co obsluha nastaví na obrazovce F1 Nastavení)
vytvoří:
  - remora.ini      konfigurace LinuxCNC
  - remora.hal      zapojení HAL (komponenta remora-eth-3.0)
  - remora.json     konfigurace firmwaru Remora pro EC300 (nahraje se přes TFTP)
"""

import copy
import json
import os

# ---------------------------------------------------------------- deska EC300

# Svorky EC300 podle oficiální konfigurace LinuxCNC/ec300-rt1052.txt.
# (data bit, název svorky, pin procesoru)
EC300_INPUTS = [
    (0, "FHA", "P3_26"), (1, "FHB", "P4_30"), (2, "SRO", "P3_19"), (3, "SRJ", "P4_20"),
    (4, "IN01", "P4_26"), (5, "IN02", "P4_27"), (6, "IN03", "P4_21"), (7, "IN04", "P4_24"),
    (8, "IN05", "P4_28"), (9, "IN06", "P4_25"), (10, "IN07", "P4_29"), (11, "IN08", "P4_23"),
    (12, "IN09", "P4_31"), (13, "IN10", "P3_18"), (14, "IN11", "P3_21"), (15, "IN12", "P3_20"),
    (16, "CIN", "P4_18"), (17, "XIN", "P4_17"), (18, "YIN", "P4_16"), (19, "ZIN", "P4_15"),
    (20, "AIN", "P4_14"), (21, "X100IN", "P4_13"), (22, "X10IN", "P4_12"), (23, "EP", "P4_11"),
    (24, "INDEX", "P3_22"), (25, "WHA", "P3_16"), (26, "WHB", "P3_17"),
]
EC300_OUTPUTS = [
    (0, "OT01", "P4_02"), (1, "OT02", "P4_01"), (2, "OT03", "P4_03"), (3, "OT04", "P4_04"),
    (4, "OT05", "P4_05"), (5, "OT06", "P4_06"), (6, "OT07", "P4_07"), (7, "OT08", "P4_08"),
    (8, "OT09", "P4_09"), (9, "OT10", "P4_10"),
]
# STEP/DIR piny pro osy 0..5 (všechny na GPIO1, podmínka DMA stepgenu)
EC300_STEPGEN = [
    ("P1_22", "P1_17"), ("P1_24", "P1_31"), ("P1_18", "P1_25"),
    ("P1_27", "P1_21"), ("P1_16", "P1_23"), ("P1_20", "P1_19"),
]

AXIS_LETTERS = "XYZABC"

# Funkce vstupů, které jde přiřadit na obrazovce Nastavení
INPUT_FUNCTIONS = {
    "estop": "E-stop (sepnuto = v pořádku)",
    "probe": "Dotyková sonda",
    "toolsetter": "Délkoměr nástroje",
}
for _a in AXIS_LETTERS:
    INPUT_FUNCTIONS["home_" + _a] = "Reference %s" % _a
    INPUT_FUNCTIONS["limneg_" + _a] = "Limit %s−" % _a
    INPUT_FUNCTIONS["limpos_" + _a] = "Limit %s+" % _a

OUTPUT_FUNCTIONS = {
    "spindle_on": "Vřeteno zapnuto",
    "spindle_ccw": "Vřeteno vlevo (M4)",
    "flood": "Chlazení (M8)",
    "mist": "Mlha (M7)",
    "enable": "Povolení driverů (stroj ZAP)",
}


def default_machine():
    """Výchozí stroj: 3osá frézka, šroub 5 mm, 200 kroků × 8 mikrokroků."""
    axes = []
    for i, letter in enumerate("XYZ"):
        axes.append({
            "letter": letter, "enabled": True,
            "steps_per_rev": 200, "microsteps": 8, "pitch": 5.0, "gear": 1.0,
            "invert_dir": False,
            "max_vel": 3000.0,          # mm/min
            "accel": 300.0,             # mm/s²
            "min_limit": -300.0 if letter == "Z" else 0.0,
            "max_limit": 0.0 if letter == "Z" else 300.0,
            "home_search_vel": 600.0 if letter == "Z" else -600.0,   # mm/min, znaménko = směr
            "home_latch_vel": 60.0 if letter == "Z" else -60.0,
            "home_position": 0.0,
            "home_offset": 0.0,
            "home_sequence": 0 if letter == "Z" else 1,
            "step_len": 3, "step_space": 3, "dir_setup": 5, "dir_hold": 5,   # µs (DM542/DMS42T: pulz ≥ 2,5 µs)
        })
    return {
        "version": 1,
        "machine_name": "Remora EC300",
        "board": "EC300",
        "board_ip": "10.10.10.10",
        "axes": axes,
        "inputs": {},          # "4": {"function": "home_X", "invert": false}
        "outputs": {},         # "0": "spindle_on"
        "spindle": {"max_rpm": 24000, "min_rpm": 0, "pwm": True},
        "require_homing": True,
    }


def normalize(m):
    """Doplní chybějící klíče z výchozí konfigurace, ořízne nesmysly."""
    base = default_machine()
    out = copy.deepcopy(base)
    for k, v in m.items():
        if k in ("axes", "inputs", "outputs", "spindle"):
            continue
        out[k] = v
    out["spindle"].update(m.get("spindle", {}))
    axes = []
    for i, a in enumerate(m.get("axes", base["axes"])[:6]):
        tmpl = copy.deepcopy(base["axes"][min(i, 2)])
        tmpl.update(a)
        tmpl["letter"] = AXIS_LETTERS[i] if not a.get("letter") else a["letter"]
        axes.append(tmpl)
    out["axes"] = axes
    in_bits = {str(b) for b, _, _ in EC300_INPUTS}
    out_bits = {str(b) for b, _, _ in EC300_OUTPUTS}
    out["inputs"] = {str(k): {"function": v["function"], "invert": bool(v.get("invert"))}
                     for k, v in m.get("inputs", {}).items()
                     if str(k) in in_bits and isinstance(v, dict) and v.get("function") in INPUT_FUNCTIONS}
    out["outputs"] = {str(k): v for k, v in m.get("outputs", {}).items()
                      if str(k) in out_bits and v in OUTPUT_FUNCTIONS}
    return out


def axis_scale(a):
    """Kroky na 1 mm (záporně = obrácený směr)."""
    steps = float(a["steps_per_rev"]) * float(a["microsteps"]) * float(a.get("gear", 1.0))
    scale = steps / float(a["pitch"])
    return -scale if a.get("invert_dir") else scale


def validate(m):
    """Vrátí seznam chyb a varování pro obrazovku Nastavení."""
    errors, warnings = [], []
    used = {}
    for bit, cfg in m["inputs"].items():
        f = cfg["function"]
        if f in used:
            errors.append("Funkce '%s' je přiřazená dvěma vstupům." % INPUT_FUNCTIONS[f])
        used[f] = bit
    enabled = [a for a in m["axes"] if a.get("enabled")]
    if not enabled:
        errors.append("Stroj musí mít alespoň jednu osu.")
    letters = [a["letter"] for a in enabled]
    if len(set(letters)) != len(letters):
        errors.append("Dvě osy mají stejné písmeno.")
    for a in enabled:
        L = a["letter"]
        try:
            sc = abs(axis_scale(a))
        except (ZeroDivisionError, ValueError, TypeError):
            errors.append("Osa %s: neplatné kroky nebo stoupání." % L)
            continue
        if a["max_limit"] <= a["min_limit"]:
            errors.append("Osa %s: maximum dráhy musí být větší než minimum." % L)
        step_hz = sc * a["max_vel"] / 60.0
        min_period_us = a["step_len"] + a["step_space"]
        max_hz = min(500000.0, 1e6 / max(min_period_us, 2))
        if step_hz > max_hz:
            errors.append("Osa %s: %.0f kHz kroků při max. rychlosti, deska zvládne %.0f kHz. "
                          "Sniž rychlost nebo mikrokrokování." % (L, step_hz / 1000, max_hz / 1000))
        elif step_hz > 0.8 * max_hz:
            warnings.append("Osa %s: frekvence kroků %.0f kHz je blízko limitu." % (L, step_hz / 1000))
        if a["accel"] <= 0 or a["max_vel"] <= 0:
            errors.append("Osa %s: rychlost i zrychlení musí být kladné." % L)
        if "home_" + L in used and a["home_search_vel"] == 0:
            warnings.append("Osa %s má referenční spínač, ale nulovou rychlost hledání." % L)
    if "estop" not in used:
        warnings.append("Není přiřazený vstup E-stop. Hardwarový E-stop musí odpojit drivery sám.")
    if len(enabled) == 6:
        warnings.append("Šestá osa (C) potřebuje firmware s opravou DIR pinu P1_19.")
    return errors, warnings


# ---------------------------------------------------------------- Remora JSON

def remora_json(m):
    mods = []
    for j, a in enumerate([a for a in m["axes"] if a.get("enabled")]):
        step, direction = EC300_STEPGEN[j]
        mods.append({
            "Thread": "DMA", "Type": "DMAstepgen",
            "Comment": "%s - joint %d" % (a["letter"], j), "Joint Number": j,
            "Step Pin": step, "Direction Pin": direction,
            "Step Length": int(a["step_len"]), "Step Space": int(a["step_space"]),
            "Dir Hold": int(a["dir_hold"]), "Dir Setup": int(a["dir_setup"]),
        })
    # všechny vstupy a výstupy desky necháme aktivní, funkce se přiřazují v HAL
    for bit, name, pin in EC300_INPUTS:
        mods.append({"Thread": "Servo", "Type": "Digital Pin", "Comment": name, "Pin": pin,
                     "Mode": "Input", "Data Bit": bit, "Invert": "True"})
    for bit, name, pin in EC300_OUTPUTS:
        mods.append({"Thread": "Servo", "Type": "Digital Pin", "Comment": name, "Pin": pin,
                     "Mode": "Output", "Data Bit": bit})
    if m["spindle"].get("pwm", True):
        mods.append({"Thread": "Servo", "Type": "Spindle PWM", "Comment": "Spindle PWM", "SP[i]": 0})
    doc = {"Board": "EC300", "Modules": mods}
    # kompaktní zápis: firmware 3.1.3 přijme soubor do ~7,6 kB
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=True)


# ---------------------------------------------------------------- INI

def _f(x, d=4):
    return ("%." + str(d) + "f") % float(x)


def ini_text(m, paths):
    axes = [a for a in m["axes"] if a.get("enabled")]
    coords = " ".join(a["letter"] for a in axes)
    max_vel = max(a["max_vel"] for a in axes) / 60.0
    L = []
    w = L.append
    w("# Vygenerováno OpenCNC Web - ruční změny se při uložení nastavení přepíšou.")
    w("[EMC]\nMACHINE = %s\nDEBUG = 0\nVERSION = 1.1\n" % m["machine_name"])
    w("[DISPLAY]\nDISPLAY = %s" % paths["display"])
    w("CYCLE_TIME = 0.100\nPOSITION_OFFSET = RELATIVE\nPOSITION_FEEDBACK = ACTUAL")
    w("MAX_FEED_OVERRIDE = 1.5\nMAX_SPINDLE_OVERRIDE = 1.2")
    w("DEFAULT_LINEAR_VELOCITY = %s\nMIN_LINEAR_VELOCITY = 0\nMAX_LINEAR_VELOCITY = %s" % (_f(max_vel / 4, 2), _f(max_vel, 2)))
    w("PROGRAM_PREFIX = %s\n" % paths["nc_files"])
    w("[KINS]\nJOINTS = %d\nKINEMATICS = trivkins coordinates=%s\n" % (len(axes), "".join(a["letter"] for a in axes)))
    w("[TASK]\nTASK = milltask\nCYCLE_TIME = 0.010\n")
    w("[RS274NGC]\nPARAMETER_FILE = linuxcnc.var\n")
    w("[EMCMOT]\nEMCMOT = motmod\nCOMM_TIMEOUT = 1.0\nBASE_PERIOD = 0\nSERVO_PERIOD = 1000000\n")
    w("[HAL]\nHALFILE = remora.hal\nHALFILE = custom.hal\n")
    w("[TRAJ]\nCOORDINATES = %s\nLINEAR_UNITS = mm\nANGULAR_UNITS = degree" % coords)
    w("DEFAULT_LINEAR_VELOCITY = %s\nMAX_LINEAR_VELOCITY = %s" % (_f(max_vel / 4, 2), _f(max_vel, 2)))
    w("NO_FORCE_HOMING = %d\n" % (0 if m.get("require_homing", True) else 1))
    w("[EMCIO]\nEMCIO = io\nCYCLE_TIME = 0.100\nTOOL_TABLE = tool.tbl\n")

    inputs = {cfg["function"]: int(bit) for bit, cfg in m["inputs"].items()}
    for j, a in enumerate(axes):
        letter = a["letter"]
        vel = a["max_vel"] / 60.0
        acc = a["accel"]
        w("[AXIS_%s]\nMAX_VELOCITY = %s\nMAX_ACCELERATION = %s\nMIN_LIMIT = %s\nMAX_LIMIT = %s\n"
          % (letter, _f(vel), _f(acc), _f(a["min_limit"]), _f(a["max_limit"])))
        w("[JOINT_%d]\nTYPE = %s" % (j, "ANGULAR" if letter in "ABC" else "LINEAR"))
        w("MIN_LIMIT = %s\nMAX_LIMIT = %s" % (_f(a["min_limit"]), _f(a["max_limit"])))
        w("MAX_VELOCITY = %s\nMAX_ACCELERATION = %s\nSTEPGEN_MAXACCEL = %s" % (_f(vel), _f(acc), _f(acc * 1.25)))
        w("SCALE = %s\nFERROR = 1.0\nMIN_FERROR = 0.5\nPGAIN = 10" % _f(axis_scale(a), 6))
        has_home = ("home_" + letter) in inputs
        if has_home:
            shared = inputs.get("home_" + letter) in (inputs.get("limneg_" + letter), inputs.get("limpos_" + letter))
            w("HOME = %s\nHOME_OFFSET = %s" % (_f(a["home_position"]), _f(a["home_offset"])))
            w("HOME_SEARCH_VEL = %s\nHOME_LATCH_VEL = %s" % (_f(a["home_search_vel"] / 60.0), _f(a["home_latch_vel"] / 60.0)))
            w("HOME_SEQUENCE = %d" % int(a["home_sequence"]))
            if shared:
                w("HOME_IGNORE_LIMITS = YES")
        else:
            # bez spínače: reference = aktuální poloha
            w("HOME = 0.0\nHOME_OFFSET = 0.0\nHOME_SEARCH_VEL = 0\nHOME_LATCH_VEL = 0")
            w("HOME_SEQUENCE = %d" % int(a["home_sequence"]))
        w("")
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- HAL

def hal_text(m):
    axes = [a for a in m["axes"] if a.get("enabled")]
    L = []
    w = L.append
    w("# Vygenerováno OpenCNC Web - vlastní úpravy patří do custom.hal")
    w("loadrt [KINS]KINEMATICS")
    w("loadrt [EMCMOT]EMCMOT base_period_nsec=[EMCMOT]BASE_PERIOD servo_period_nsec=[EMCMOT]SERVO_PERIOD num_joints=[KINS]JOINTS")
    w("loadrt remora-eth-3.0 PRU_base_freq=500000")

    inputs = {}   # funkce -> (bit, invert)
    for bit, cfg in m["inputs"].items():
        inputs[cfg["function"]] = (int(bit), bool(cfg.get("invert")))
    outputs = {}  # funkce -> bit
    for bit, f in m["outputs"].items():
        outputs[f] = int(bit)

    spindle_pwm = m["spindle"].get("pwm", True) and float(m["spindle"].get("max_rpm", 0)) > 0
    both_probes = "probe" in inputs and "toolsetter" in inputs
    if "estop" in inputs:
        w("loadrt and2 count=1")
    if both_probes:
        w("loadrt or2 count=1")
    if spindle_pwm:
        w("loadrt scale count=1")
    w("")
    w("addf remora.read servo-thread")
    w("addf motion-command-handler servo-thread")
    w("addf motion-controller servo-thread")
    w("addf remora.update-freq servo-thread")
    w("addf remora.write servo-thread")
    if "estop" in inputs:
        w("addf and2.0 servo-thread")
    if both_probes:
        w("addf or2.0 servo-thread")
    if spindle_pwm:
        w("addf scale.0 servo-thread")
    w("")

    # E-stop řetězec: komunikace s deskou AND externí E-stop
    w("net user-enable-out iocontrol.0.user-enable-out => remora.enable")
    w("net user-request-enable iocontrol.0.user-request-enable => remora.reset")
    if "estop" in inputs:
        w("net remora-status remora.status => and2.0.in0")
        w("net estop-enable and2.0.out => iocontrol.0.emc-enable-in")
    else:
        w("net remora-status remora.status => iocontrol.0.emc-enable-in")
    w("")

    for j, a in enumerate(axes):
        w("setp remora.joint.%d.scale [JOINT_%d]SCALE" % (j, j))
        w("setp remora.joint.%d.maxaccel [JOINT_%d]STEPGEN_MAXACCEL" % (j, j))
        w("setp remora.joint.%d.pgain [JOINT_%d]PGAIN" % (j, j))
        w("net j%dpos-cmd joint.%d.motor-pos-cmd => remora.joint.%d.pos-cmd" % (j, j, j))
        w("net j%dpos-fb remora.joint.%d.pos-fb => joint.%d.motor-pos-fb" % (j, j, j))
        w("net j%denable joint.%d.amp-enable-out => remora.joint.%d.enable" % (j, j, j))
        w("")

    # vstupy: jeden signál na zdrojový pin, může vést do více cílů (sdílený home + limit)
    readers = {}
    joint_of = {a["letter"]: j for j, a in enumerate(axes)}
    for f, (bit, inv) in inputs.items():
        src = "remora.input.%02d%s" % (bit, ".not" if inv else "")
        targets = []
        if f == "estop":
            targets.append("and2.0.in1")
        elif f in ("probe", "toolsetter"):
            # sonda i délkoměr současně: sloučit přes or2
            if both_probes:
                targets.append("or2.0.in0" if f == "probe" else "or2.0.in1")
            else:
                targets.append("motion.probe-input")
        else:
            kind, letter = f.split("_")
            if letter not in joint_of:
                continue
            j = joint_of[letter]
            targets.append({"home": "joint.%d.home-sw-in", "limneg": "joint.%d.neg-lim-sw-in",
                            "limpos": "joint.%d.pos-lim-sw-in"}[kind] % j)
        readers.setdefault(src, []).extend(targets)
    for src, targets in sorted(readers.items()):
        uniq = list(dict.fromkeys(targets))
        name = "in-" + src.replace("remora.input.", "").replace(".not", "-not")
        w("net %s %s => %s" % (name, src, " ".join(uniq)))
    if both_probes:
        w("net probe-any or2.0.out => motion.probe-input")
    w("")

    # vřeteno
    if spindle_pwm:
        w("setp scale.0.gain %s" % _f(100.0 / float(m["spindle"]["max_rpm"]), 8))
        w("net spindle-speed spindle.0.speed-out-abs => scale.0.in")
        w("net spindle-pwm scale.0.out => remora.SP.0")
    if "spindle_on" in outputs:
        w("net spindle-on spindle.0.on => remora.output.%02d" % outputs["spindle_on"])
    if "spindle_ccw" in outputs:
        w("net spindle-ccw spindle.0.reverse => remora.output.%02d" % outputs["spindle_ccw"])
    if "flood" in outputs:
        w("net coolant-flood iocontrol.0.coolant-flood => remora.output.%02d" % outputs["flood"])
    if "mist" in outputs:
        w("net coolant-mist iocontrol.0.coolant-mist => remora.output.%02d" % outputs["mist"])
    if "enable" in outputs:
        w("net machine-on motion.motion-enabled => remora.output.%02d" % outputs["enable"])
    w("")
    # výměna nástroje: zatím bez ručního dialogu, M6 se potvrdí automaticky
    w("net tool-change iocontrol.0.tool-change => iocontrol.0.tool-changed")
    w("net tool-prepare iocontrol.0.tool-prepare => iocontrol.0.tool-prepared")
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- zápis

def write_config(m, config_dir, display_cmd):
    """Zapíše INI/HAL/JSON. Vrací dict s cestami. Neexistující pomocné soubory založí."""
    os.makedirs(config_dir, exist_ok=True)
    nc = os.path.join(config_dir, "nc_files")
    os.makedirs(nc, exist_ok=True)
    paths = {"display": display_cmd, "nc_files": nc}
    files = {
        "remora.ini": ini_text(m, paths),
        "remora.hal": hal_text(m),
        "remora.json": remora_json(m),
        "machine.json": json.dumps(m, indent=2, ensure_ascii=False),
    }
    for name, text in files.items():
        tmp = os.path.join(config_dir, name + ".tmp")
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(tmp, os.path.join(config_dir, name))
    for name, text in (("custom.hal", "# Vlastní HAL příkazy. OpenCNC Web tento soubor nepřepisuje.\n"),
                       ("tool.tbl", "T1 P1 Z0.000 D6.000 ;fréza 6 mm\n"),
                       ("linuxcnc.var", "")):
        p = os.path.join(config_dir, name)
        if not os.path.exists(p):
            with open(p, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
    return {"ini": os.path.join(config_dir, "remora.ini"),
            "json": os.path.join(config_dir, "remora.json"),
            "json_size": len(files["remora.json"])}
