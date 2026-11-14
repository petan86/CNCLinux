/* OpenCNC Web - 3D náhled drah G-kódu bez externích knihoven.
   Parser: G0/G1/G2/G3 (oblouky v rovině G17 přes I/J nebo R, šroubovice), G90/G91, G20/G21.
   Zobrazení: ortografická projekce na canvasu, otáčení jedním prstem, zoom a posun dvěma. */
"use strict";
const Toolpath = (() => {
  const MAX_SEG = 500000;

  function parse(text) {
    const P = [], T = [], L = [];          // body (6 čísel na segment), typ (0 rychloposuv, 1 řez), řádek
    let x = 0, y = 0, z = 0, abs = true, sc = 1, motion = 0, plane = 17, count = 0;
    let cR = 0, cZ = 0, cInit = 0, retractR = false;          // vrtací cykly G81/G82/G83/G73
    const lines = text.split("\n");
    for (let li = 0; li < lines.length && count < MAX_SEG; li++) {
      const raw = lines[li].toUpperCase().replace(/\(.*?\)/g, "").replace(/;.*/, "").replace(/\s+/g, "");
      if (!raw) continue;
      const words = raw.match(/[A-Z][+-]?(?:\d+\.?\d*|\.\d+)/g);
      if (!words) continue;
      const w = {}, gs = [];
      for (const wd of words) {
        const k = wd[0], v = parseFloat(wd.slice(1));
        if (k === "G") gs.push(v); else w[k] = v;
      }
      let skip = false;
      for (const g of gs) {
        if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
        else if (g === 20) sc = 25.4;
        else if (g === 21) sc = 1;
        else if (g === 90) abs = true;
        else if (g === 91) abs = false;
        else if (g === 17 || g === 18 || g === 19) plane = g;
        else if ([4, 10, 28, 30, 53, 92].includes(Math.floor(g))) skip = true;
        else if (g === 80) motion = -1;
        else if ([73, 81, 82, 83, 85, 89].includes(g)) { if (motion !== 81) cInit = z; motion = 81; }
        else if (g === 98) retractR = false;
        else if (g === 99) retractR = true;
      }
      if (skip || motion < 0) continue;
      if (motion === 81) {
        if ("R" in w) cR = w.R * sc;
        if ("Z" in w) cZ = w.Z * sc;
        if (!("X" in w || "Y" in w)) continue;
        const hx = "X" in w ? (abs ? w.X * sc : x + w.X * sc) : x;
        const hy = "Y" in w ? (abs ? w.Y * sc : y + w.Y * sc) : y;
        const top = Math.max(cInit, cR);
        const seg = (a, b, c, d, e, f2, ty) => { P.push(a, b, c, d, e, f2); T.push(ty); L.push(li + 1); count++; };
        seg(x, y, z, hx, hy, z, 0);
        if (z !== cR) seg(hx, hy, z, hx, hy, cR, 0);
        seg(hx, hy, cR, hx, hy, cZ, 1);
        const back = retractR ? cR : top;
        seg(hx, hy, cZ, hx, hy, back, 0);
        x = hx; y = hy; z = back;
        continue;
      }
      if (!("X" in w || "Y" in w || "Z" in w)) continue;
      const nx = "X" in w ? (abs ? w.X * sc : x + w.X * sc) : x;
      const ny = "Y" in w ? (abs ? w.Y * sc : y + w.Y * sc) : y;
      const nz = "Z" in w ? (abs ? w.Z * sc : z + w.Z * sc) : z;
      if ((motion === 2 || motion === 3) && plane === 17) {
        let cx, cy;
        if ("R" in w) {
          const r = w.R * sc, dx = nx - x, dy = ny - y, d = Math.hypot(dx, dy);
          if (d === 0) { x = nx; y = ny; z = nz; continue; }
          const h = Math.sqrt(Math.max(0, r * r - d * d / 4));
          let side = motion === 2 ? 1 : -1;
          if (r < 0) side = -side;
          cx = (x + nx) / 2 + side * h * dy / d;
          cy = (y + ny) / 2 - side * h * dx / d;
        } else {
          cx = x + (w.I || 0) * sc;
          cy = y + (w.J || 0) * sc;
        }
        const r = Math.hypot(x - cx, y - cy);
        let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
        const cw = motion === 2;
        let sweep = a1 - a0;
        if (cw && sweep >= 0) sweep -= 2 * Math.PI;
        if (!cw && sweep <= 0) sweep += 2 * Math.PI;
        if (Math.abs(nx - x) < 1e-9 && Math.abs(ny - y) < 1e-9) sweep = cw ? -2 * Math.PI : 2 * Math.PI;
        const n = Math.min(360, Math.max(6, Math.ceil(Math.abs(sweep) * r / 0.5)));
        let px = x, py = y, pz = z;
        for (let i = 1; i <= n; i++) {
          const a = a0 + sweep * i / n;
          const qx = i === n ? nx : cx + r * Math.cos(a);
          const qy = i === n ? ny : cy + r * Math.sin(a);
          const qz = z + (nz - z) * i / n;
          P.push(px, py, pz, qx, qy, qz); T.push(1); L.push(li + 1); count++;
          px = qx; py = qy; pz = qz;
        }
      } else {
        P.push(x, y, z, nx, ny, nz); T.push(motion === 0 ? 0 : 1); L.push(li + 1); count++;
      }
      x = nx; y = ny; z = nz;
    }
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) {
      for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], P[i + k]); b[k + 3] = Math.max(b[k + 3], P[i + k]); }
    }
    return { p: new Float32Array(P), t: new Uint8Array(T), l: new Int32Array(L), bounds: P.length ? b : [0, 0, 0, 1, 1, 1],
             truncated: count >= MAX_SEG, lines: lines.length };
  }

  const VIEWS = { top: [0, 0], iso: [-Math.PI / 4, 0.95], front: [0, Math.PI / 2] };

  function create(container, infoEl) {
    const canvas = container.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    let data = null, yaw = VIEWS.iso[0], pitch = VIEWS.iso[1], zoom = 1, panX = 0, panY = 0;
    let line = 0, tool = null, dirty = true, w = 0, h = 0, dpr = 1;

    function proj(x, y, z) {
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const x1 = x * cy - y * sy, y1 = x * sy + y * cy;
      return [x1 * zoom + w / 2 + panX, -(y1 * cp + z * sp) * zoom + h / 2 + panY];
    }

    function fit() {
      if (!data) { zoom = 1; panX = panY = 0; dirty = true; return; }
      const b = data.bounds;
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      const saveZ = zoom, sx = panX, sy = panY;
      zoom = 1; panX = -w / 2; panY = -h / 2;
      for (const X of [b[0], b[3]]) for (const Y of [b[1], b[4]]) for (const Z of [b[2], b[5]]) {
        const [px, py] = proj(X, Y, Z);
        minx = Math.min(minx, px); maxx = Math.max(maxx, px); miny = Math.min(miny, py); maxy = Math.max(maxy, py);
      }
      const spanX = Math.max(maxx - minx, 1e-3), spanY = Math.max(maxy - miny, 1e-3);
      zoom = Math.min((w - 40) / spanX, (h - 60) / spanY);
      if (!isFinite(zoom) || zoom <= 0) { zoom = saveZ; panX = sx; panY = sy; return; }
      panX = -((minx + maxx) / 2) * zoom;
      panY = -((miny + maxy) / 2) * zoom;
      dirty = true;
    }

    function resize() {
      const r = container.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      const nw = Math.max(1, Math.round(r.width)), nh = Math.max(1, Math.round(r.height));
      if (nw === w && nh === h) return;
      const first = w <= 1;          // náhled byl skrytý (nulová velikost): po zobrazení přizpůsobit
      w = nw; h = nh;
      canvas.width = w * dpr; canvas.height = h * dpr;
      if (first) fit();
      dirty = true;
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // osy obrobku v nule
      const axLen = data ? (Math.max(data.bounds[3] - data.bounds[0], data.bounds[4] - data.bounds[1], data.bounds[5] - data.bounds[2]) || 50) * 0.15 : 20;
      const o = proj(0, 0, 0);
      [[axLen, 0, 0, "#ff4a4a"], [0, axLen, 0, "#3ccf5a"], [0, 0, axLen, "#22d3e6"]].forEach(([X, Y, Z, c]) => {
        const e = proj(X, Y, Z);
        ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(e[0], e[1]); ctx.stroke();
      });
      if (data) {
        const p = data.p, t = data.t, l = data.l, n = t.length;
        const pass = (filter, style, width, dash) => {
          ctx.strokeStyle = style; ctx.lineWidth = width; ctx.setLineDash(dash);
          ctx.beginPath();
          let lx = NaN, ly = NaN;
          for (let i = 0; i < n; i++) {
            if (!filter(t[i], l[i])) continue;
            const j = i * 6;
            const a = proj(p[j], p[j + 1], p[j + 2]), b = proj(p[j + 3], p[j + 4], p[j + 5]);
            if (a[0] !== lx || a[1] !== ly) ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]); lx = b[0]; ly = b[1];
          }
          ctx.stroke(); ctx.setLineDash([]);
        };
        pass((ty) => ty === 0, "rgba(235,245,248,.65)", 1, [2, 4]);
        pass((ty, ln) => ty === 1 && ln >= line, "#ffd23f", 1.5, []);
        if (line > 0) pass((ty, ln) => ty === 1 && ln < line, "#3ccf5a", 1.8, []);
      }
      if (tool) {
        const [tx, ty] = proj(tool[0], tool[1], tool[2]);
        const [ux, uy] = proj(tool[0], tool[1], tool[2] + 15 / Math.max(zoom, 0.01) * 2);
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ux, uy); ctx.stroke();
        ctx.beginPath(); ctx.arc(tx, ty, 5, 0, Math.PI * 2); ctx.stroke();
      }
    }

    function loop() {
      resize();
      if (dirty) { dirty = false; draw(); }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    // ---- dotyk a myš ----
    const ptrs = new Map();
    let lastDist = 0, lastMid = null, lastTap = 0;
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 1) {
        const now = Date.now();
        if (now - lastTap < 300) fit();
        lastTap = now;
      }
      lastDist = 0; lastMid = null;
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!ptrs.has(e.pointerId)) return;
      const prev = ptrs.get(e.pointerId);
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 1) {
        if (e.buttons === 4 || e.shiftKey) { panX += e.clientX - prev[0]; panY += e.clientY - prev[1]; }
        else {
          yaw += (e.clientX - prev[0]) * 0.01;
          pitch = Math.max(0, Math.min(Math.PI, pitch + (e.clientY - prev[1]) * 0.01));
        }
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (lastDist) zoomAt(dist / lastDist, mid);
        if (lastMid) { panX += mid[0] - lastMid[0]; panY += mid[1] - lastMid[1]; }
        lastDist = dist; lastMid = mid;
      }
      dirty = true;
    });
    const up = (e) => { ptrs.delete(e.pointerId); lastDist = 0; lastMid = null; };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, [e.clientX, e.clientY]); }, { passive: false });

    function zoomAt(f, client) {
      const r = canvas.getBoundingClientRect();
      const mx = client[0] - r.left - w / 2, my = client[1] - r.top - h / 2;
      panX = mx - (mx - panX) * f; panY = my - (my - panY) * f; zoom *= f; dirty = true;
    }

    function info() {
      if (!infoEl) return;
      if (!data) { infoEl.textContent = ""; return; }
      const b = data.bounds, f = (v) => v.toFixed(1);
      infoEl.textContent = `X ${f(b[0])}…${f(b[3])}  Y ${f(b[1])}…${f(b[4])}  Z ${f(b[2])}…${f(b[5])}  ·  ${data.t.length} úseků` +
        (data.truncated ? " (zkráceno)" : "");
    }

    return {
      load(text) { data = text ? parse(text) : null; line = 0; resize(); fit(); info(); },
      clear() { data = null; info(); dirty = true; },
      setLine(n) { if (n !== line) { line = n; dirty = true; } },
      setTool(pos) {
        if (!pos) { if (tool) { tool = null; dirty = true; } return; }
        if (!tool || pos.some((v, i) => Math.abs(v - tool[i]) > 1e-4)) { tool = pos; dirty = true; }
      },
      view(name) {
        if (name === "fit") return fit();
        [yaw, pitch] = VIEWS[name]; fit();
      },
      redraw() { dirty = true; },
    };
  }

  return { parse, create };
})();
