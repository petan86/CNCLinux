/* OpenCNC Web - konverzační průvodci (F5): jednoduché programy bez CAM.
   Konvence: nula obrobku Z0 = horní plocha materiálu, metrické jednotky, G90. */
"use strict";
const Wizards = (() => {
  const common = [
    ["tool", "Průměr nástroje", "mm", 6],
    ["rpm", "Otáčky vřetena", "ot/min", 12000],
    ["feed", "Posuv", "mm/min", 800],
    ["plunge", "Posuv zanoření", "mm/min", 200],
    ["safe", "Bezpečná výška Z", "mm", 5],
  ];
  const DEFS = {
    face: {
      title: "Zarovnání plochy",
      note: "Cik-cak ve směru X přes celý obdélník, nástroj přesahuje hrany o polovinu průměru.",
      fields: [["x0", "Začátek X", "mm", 0], ["y0", "Začátek Y", "mm", 0], ["w", "Šířka X", "mm", 100], ["l", "Délka Y", "mm", 60],
               ["depth", "Celková hloubka", "mm", 0.5], ["step", "Hloubka na průchod", "mm", 0.5], ["over", "Překrytí drah", "%", 60], ...common],
      gen: face,
    },
    rect: {
      title: "Obdélníková kapsa",
      note: "Rohy kapsy zůstanou zaoblené poloměrem nástroje. Zanoření je kolmé, použij frézu, která umí vrtat, nebo malou hloubku na průchod.",
      fields: [["x0", "Roh X", "mm", 0], ["y0", "Roh Y", "mm", 0], ["w", "Šířka X", "mm", 40], ["l", "Délka Y", "mm", 25],
               ["depth", "Hloubka kapsy", "mm", 3], ["step", "Hloubka na průchod", "mm", 1], ["over", "Překrytí drah", "%", 45], ...common],
      gen: rect,
    },
    circ: {
      title: "Kruhová kapsa",
      note: "Soustředné kružnice od středu ven. Zanoření je kolmé ve středu kapsy.",
      fields: [["xc", "Střed X", "mm", 0], ["yc", "Střed Y", "mm", 0], ["d", "Průměr kapsy", "mm", 30],
               ["depth", "Hloubka kapsy", "mm", 3], ["step", "Hloubka na průchod", "mm", 1], ["over", "Překrytí drah", "%", 45], ...common],
      gen: circ,
    },
    drill: {
      title: "Vrtání v mřížce",
      note: "Cyklus G81 (bez výplachu) nebo G83 (s výplachem, když je krok výplachu > 0). Návrat do roviny R.",
      fields: [["x0", "První díra X", "mm", 0], ["y0", "První díra Y", "mm", 0], ["nx", "Počet děr v X", "", 3], ["ny", "Počet děr v Y", "", 2],
               ["dx", "Rozteč X", "mm", 20], ["dy", "Rozteč Y", "mm", 20], ["depth", "Hloubka díry", "mm", 10], ["peck", "Výplach po", "mm", 2],
               ["rplane", "Rovina R", "mm", 2], ["rpm", "Otáčky vřetena", "ot/min", 3000], ["plunge", "Posuv vrtání", "mm/min", 100], ["safe", "Bezpečná výška Z", "mm", 5]],
      gen: drill,
    },
  };

  const f = (v) => (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "") || "0";

  function header(p, title) {
    return [`(OpenCNC Web - ${title})`, `(vygenerováno ${new Date().toLocaleString("cs-CZ")})`, "G21 G90 G17 G94 G40 G49 G80",
            `G0 Z${f(p.safe)}`, `S${Math.round(p.rpm)} M3`, "G4 P2"];
  }
  function footer(p) { return [`G0 Z${f(p.safe)}`, "M5", "M2"]; }
  function levels(depth, step) {
    const out = [], n = Math.max(1, Math.ceil(depth / Math.max(step, 0.01) - 1e-9));
    for (let i = 1; i <= n; i++) out.push(-Math.min(depth, (depth * i) / n));
    return out;
  }
  function check(p, keys) {
    for (const k of keys) if (!(p[k] > 0)) throw new Error("Hodnota „" + k + "“ musí být kladná.");
  }

  function face(p) {
    check(p, ["w", "l", "tool", "depth", "step", "over", "feed", "plunge"]);
    const g = header(p, "zarovnání plochy " + f(p.w) + "×" + f(p.l));
    const r = p.tool / 2, so = p.tool * p.over / 100;
    const xa = p.x0 - r, xb = p.x0 + p.w + r;
    for (const z of levels(p.depth, p.step)) {
      let y = p.y0, dir = 1;
      g.push(`G0 X${f(xa - r)} Y${f(y)}`, `G1 Z${f(z)} F${f(p.plunge)}`);
      while (true) {
        g.push(`G1 X${f(dir > 0 ? xb : xa)} F${f(p.feed)}`);
        if (y >= p.y0 + p.l - 1e-9) break;
        y = Math.min(p.y0 + p.l, y + so);
        g.push(`G1 Y${f(y)}`);
        dir = -dir;
      }
      g.push(`G0 Z${f(p.safe)}`);
    }
    return [...g, ...footer(p)].join("\n");
  }

  function rect(p) {
    check(p, ["w", "l", "tool", "depth", "step", "over", "feed", "plunge"]);
    if (p.tool >= p.w || p.tool >= p.l) throw new Error("Nástroj je větší než kapsa.");
    const g = header(p, "obdélníková kapsa " + f(p.w) + "×" + f(p.l));
    const r = p.tool / 2, so = p.tool * p.over / 100;
    const x1 = p.x0 + r, x2 = p.x0 + p.w - r, y1 = p.y0 + r, y2 = p.y0 + p.l - r;
    for (const z of levels(p.depth, p.step)) {
      g.push(`G0 X${f(x1)} Y${f(y1)}`, `G1 Z${f(z)} F${f(p.plunge)}`);
      let y = y1, dir = 1;
      while (true) {                       // hrubování cik-cak
        g.push(`G1 X${f(dir > 0 ? x2 : x1)} F${f(p.feed)}`);
        if (y >= y2 - 1e-9) break;
        y = Math.min(y2, y + so);
        g.push(`G1 Y${f(y)}`);
        dir = -dir;
      }
      g.push(`G1 X${f(x1)} Y${f(y1)}`, `G1 X${f(x2)}`, `G1 Y${f(y2)}`, `G1 X${f(x1)}`, `G1 Y${f(y1)}`);   // dokončení obvodu
      g.push(`G0 Z${f(p.safe)}`);
    }
    return [...g, ...footer(p)].join("\n");
  }

  function circ(p) {
    check(p, ["d", "tool", "depth", "step", "over", "feed", "plunge"]);
    if (p.tool >= p.d) throw new Error("Nástroj je větší než kapsa.");
    const g = header(p, "kruhová kapsa Ø" + f(p.d));
    const rmax = p.d / 2 - p.tool / 2, so = p.tool * p.over / 100;
    for (const z of levels(p.depth, p.step)) {
      g.push(`G0 X${f(p.xc)} Y${f(p.yc)}`, `G1 Z${f(z)} F${f(p.plunge)}`);
      let r = Math.min(so, rmax);
      while (true) {
        g.push(`G1 X${f(p.xc + r)} Y${f(p.yc)} F${f(p.feed)}`, `G3 X${f(p.xc + r)} Y${f(p.yc)} I${f(-r)} J0`);
        if (r >= rmax - 1e-9) break;
        r = Math.min(rmax, r + so);
      }
      g.push(`G0 Z${f(p.safe)}`);
    }
    return [...g, ...footer(p)].join("\n");
  }

  function drill(p) {
    check(p, ["nx", "ny", "depth", "plunge"]);
    const g = header(p, "vrtání " + p.nx + "×" + p.ny);
    const cyc = p.peck > 0 ? `G98 G83 Z${f(-p.depth)} R${f(p.rplane)} Q${f(p.peck)} F${f(p.plunge)}` : `G98 G81 Z${f(-p.depth)} R${f(p.rplane)} F${f(p.plunge)}`;
    let first = true;
    for (let j = 0; j < p.ny; j++) {
      const row = [];
      for (let i = 0; i < p.nx; i++) row.push(p.x0 + i * p.dx);
      if (j % 2) row.reverse();
      for (const x of row) {
        const y = p.y0 + j * p.dy;
        if (first) { g.push(`G0 X${f(x)} Y${f(y)}`, cyc); first = false; }
        else g.push(`X${f(x)} Y${f(y)}`);
      }
    }
    g.push("G80");
    return [...g, ...footer(p)].join("\n");
  }

  function fileName(kind, p) {
    const d = { face: `plocha-${f(p.w)}x${f(p.l)}`, rect: `kapsa-${f(p.w)}x${f(p.l)}x${f(p.depth)}`,
                circ: `kapsa-D${f(p.d)}x${f(p.depth)}`, drill: `vrtani-${p.nx}x${p.ny}` }[kind];
    return "pruvodce-" + d.replace(/[^A-Za-z0-9.\-]/g, "_") + ".ngc";
  }

  return { DEFS, fileName };
})();
