
// =============================================================================
// S700 configurator · «ORIEL» tactical skin — skin behaviour
// -----------------------------------------------------------------------------
// app.js still runs the interface. This file only adds what belongs to the
// skin: the telemetry frame (clock, depth, ticker), the canvas background
// lattice, the per-section state change and the custom select that writes
// into app.js's native <select>.
// =============================================================================
(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const pad = (n, l = 2) => String(Math.floor(n)).padStart(l, "0");
  const REDUCE = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* --------------------------------------------------------------- selects */
  // Each native <select> stays (it is the source of truth for app.js) and the
  // «rib» mounts on top: on hover the options unfold like ribs on a spine,
  // staggered; a click pins them open.
  const SEL = "sel-native";
  const kindClass = v => (v && v[0] === "k" ? " is-key" : v && v[0] === "m" ? " is-media"
    : v && v[0] === "x" ? " is-macro" : "");

  const labelOf = select => {
    const o = select.selectedOptions && select.selectedOptions[0];
    return (o ? o.textContent : select.value || "").trim();
  };

  function paint(select) {
    const wrap = select.closest(".sel");
    if (!wrap) return;
    const val = wrap.querySelector(".sel-val");
    const btn = wrap.querySelector(".sel-btn");
    if (!val || !btn) return;
    val.textContent = labelOf(select) || "—";
    btn.className = "sel-btn" + kindClass(select.value);
    btn.disabled = select.disabled;
    btn.setAttribute("aria-expanded", wrap.dataset.open === "1" ? "true" : "false");
    wrap.dataset.value = select.value;
  }

  function fillMenu(select) {
    const wrap = select.closest(".sel");
    const menu = wrap.querySelector(".sel-menu");
    menu.textContent = "";
    let lastGroup = null;

    const addGroup = label => {
      const g = document.createElement("div");
      g.className = "sel-opt group";
      g.setAttribute("role", "presentation");
      const t = document.createElement("span");
      t.className = "txt";
      t.textContent = label;
      g.appendChild(t);
      menu.appendChild(g);
    };

    const addOption = opt => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sel-opt";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", opt.value === select.value ? "true" : "false");
      const t = document.createElement("span");
      t.className = "txt";
      t.textContent = opt.textContent;
      b.appendChild(t);
      b.title = opt.textContent;
      b.disabled = !!opt.disabled;
      if (!opt.disabled) b.onclick = () => {
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        select.dispatchEvent(new Event("input", { bubbles: true }));
        close(select);
        paint(select);
      };
      menu.appendChild(b);
    };

    // app.js groups options with <optgroup>: each group becomes its own header
    [...select.children].forEach(node => {
      if (node.tagName === "OPTGROUP") {
        if (node.label && node.label !== lastGroup) addGroup(node.label);
        lastGroup = node.label;
        [...node.children].forEach(addOption);
      } else if (node.tagName === "OPTION") {
        addOption(node);
      }
    });
  }

  function place(select) {
    const wrap = select.closest(".sel");
    const menu = wrap.querySelector(".sel-menu");
    menu.style.top = "";
    menu.style.bottom = "";
    menu.style.left = "0";
    menu.style.right = "";
    menu.style.marginLeft = "";
    const r = menu.getBoundingClientRect();
    const vh = window.innerHeight, vw = window.innerWidth;
    if (r.bottom > vh - 10 && r.top > r.height) { menu.style.top = "auto"; menu.style.bottom = "calc(100% + 3px)"; }
    if (r.right > vw - 10) { menu.style.left = "auto"; menu.style.right = "0"; }
    if (r.left < 6) { menu.style.left = "0"; menu.style.right = ""; }
    // if it still spills left (scrolled table, modal…), we push it back in
    const r2 = menu.getBoundingClientRect();
    if (r2.left < 6) menu.style.marginLeft = (6 - r2.left) + "px";
    if (r2.right > vw - 6) menu.style.marginLeft = Math.max(-(r2.right - vw + 6), 6 - r2.left) + "px";
  }

  function open(select) {
    const wrap = select.closest(".sel");
    if (!wrap || select.disabled) return;
    $$('.sel[data-open="1"]').forEach(w => { if (w !== wrap) close(w.querySelector("select")); });
    fillMenu(select);
    const menu = wrap.querySelector(".sel-menu");
    menu.hidden = false;
    wrap.dataset.open = "1";
    paint(select);
    place(select);
    const cur = menu.querySelector('[aria-selected="true"]');
    if (cur && menu.scrollHeight > menu.clientHeight) cur.scrollIntoView({ block: "nearest" });
  }

  function close(select) {
    const wrap = select && select.closest(".sel");
    if (!wrap) return;
    wrap.dataset.open = "0";
    const menu = wrap.querySelector(".sel-menu");
    if (menu) { menu.hidden = true; menu.style.top = ""; menu.style.bottom = ""; }
    paint(select);
  }

  function enhance(select) {
    if (!select || select.classList.contains(SEL)) return;
    const wrap = document.createElement("div");
    wrap.className = "sel";
    wrap.dataset.open = "0";
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add(SEL);
    select.tabIndex = -1;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sel-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", select.getAttribute("aria-label") || select.id || "option");
    btn.innerHTML = '<span class="sel-val"></span><span class="sel-caret">▼</span>';

    const menu = document.createElement("div");
    menu.className = "sel-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;

    wrap.appendChild(btn);
    wrap.appendChild(menu);

    // click: opens and pins it; if it was already pinned, closes it
    btn.onclick = e => {
      e.preventDefault();
      if (wrap.dataset.open === "1") close(select);
      else open(select);
    };

    btn.onkeydown = e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open(select);
        const opts = [...menu.querySelectorAll(".sel-opt:not(:disabled)")];
        const cur = menu.querySelector('[aria-selected="true"]') || opts[0];
        if (cur) cur.focus();
      }
    };
    menu.onkeydown = e => {
      const opts = [...menu.querySelectorAll(".sel-opt:not(:disabled)")];
      const at = opts.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = opts[(at + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length];
        if (next) next.focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (document.activeElement && document.activeElement.click) document.activeElement.click();
      } else if (e.key === "Escape" || e.key === "Tab") {
        close(select);
        if (e.key === "Escape") { e.preventDefault(); btn.focus(); }
      } else if (e.key.length === 1) {
        const ch = e.key.toLowerCase();
        const hit = opts.find(o => (o.textContent || "").trim().toLowerCase().startsWith(ch));
        if (hit) hit.focus();
      }
    };
    select.addEventListener("change", () => paint(select));
    paint(select);
  }

  const enhanceAll = (root = document) => root.querySelectorAll("select").forEach(enhance);

  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === "childList") {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches("select")) enhance(n);
          if (n.querySelectorAll) enhanceAll(n);
        }
        if (m.target && m.target.tagName === "SELECT") paint(m.target);
      } else if (m.type === "attributes" && m.target.tagName === "SELECT") {
        paint(m.target);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });

  document.addEventListener("pointerdown", e => {
    $$('.sel[data-open="1"]').forEach(w => { if (!w.contains(e.target)) close(w.querySelector("select")); });
  }, true);

  setInterval(() => {
    $$("select." + SEL).forEach(s => {
      const wrap = s.closest(".sel");
      if (wrap && wrap.dataset.value !== s.value) paint(s);
    });
  }, 300);

  enhanceAll();

  /* ------------------------------------------------------- frame: sections */
  const secs = $$("main .sec");
  const stateTag = $("stateTag");
  const idx = $("index");
  let curState = "buttons";

  if (idx) {
    secs.forEach(s => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.id = s.id;
      b.setAttribute("aria-current", s.id === secs[0].id ? "true" : "false");
      b.innerHTML = `<span class="l">${s.dataset.l || ""}</span><span class="k">${s.dataset.k || "・"}</span>`;
      b.setAttribute("aria-label", s.dataset.l || s.id);
      b.onclick = () => {
        const el = document.getElementById(s.id);
        if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 40, behavior: REDUCE ? "auto" : "smooth" });
      };
      idx.appendChild(b);
    });
  }

  function setState(sec) {
    const name = sec.dataset.state || "buttons";
    if (name === curState) return;
    curState = name;
    document.body.dataset.state = name;
    if (stateTag) stateTag.textContent = sec.dataset.label || name.toUpperCase();
    const key = sec.id;
    $$("#index button").forEach(b => b.setAttribute("aria-current", b.dataset.id === key ? "true" : "false"));
  }

  if (secs.length) {
    document.body.dataset.state = secs[0].dataset.state || "buttons";
    if (stateTag) stateTag.textContent = secs[0].dataset.label || "BUTTONS";
    const io = new IntersectionObserver(entries => {
      const hit = entries.filter(e => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (hit) setState(hit.target);
    }, { rootMargin: "-45% 0px -45% 0px", threshold: [0, .05, .3] });
    secs.forEach(s => io.observe(s));
  }

  /* ------------------------------------------------- frame: clock and depth */
  const clockEl = $("clock");
  const altEl = $("alt");
  const ind = $("ind");
  const barBuild = $("buildVal");
  if (barBuild && window.__S700_BUILD__) barBuild.textContent = window.__S700_BUILD__;

  function tickClock() {
    const d = new Date();
    if (clockEl) clockEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds() / 10)}`;
  }
  tickClock();
  setInterval(tickClock, 100);

  function paintDepth() {
    const h = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const p = Math.min(1, window.scrollY / h);
    const depth = Math.round(p * 1180);
    if (altEl) altEl.textContent = "-" + pad(depth, 4);
    if (ind) { ind.style.top = (p * 100) + "%"; ind.dataset.d = pad(depth, 4) + " M"; }
  }
  paintDepth();
  addEventListener("scroll", paintDepth, { passive: true });
  addEventListener("resize", paintDepth);

  /* ------------------------------------------------ frame: ticker and arena */
  const tickEl = $("tick");
  const arenaEl = $("arenaVal");
  const linkEl = $("linkState");
  const status = $("status");
  const lines = [
    "S700 :: CONFIG ORIGIN BROWSER", "MACRO ARENA :: 0x400–0x4BF", "LED BANK :: 0x1C / 0x33",
    "PROTOCOL :: FEATURE REPORT 07", "APPLY :: WHOLE IMAGE, 132 BLOCKS", "LIBRARY :: 0x4C0–0x567"
  ];
  let li = 0, lastStatus = "";

  if (status) {
    const syncStatus = () => {
      const t = status.textContent.trim();
      if (!t || t === lastStatus) return;
      lastStatus = t;
      const up = !/no device|disconnected|error/i.test(t);
      if (linkEl) { linkEl.textContent = up ? "UP" : "DOWN"; linkEl.className = up ? "up" : "down"; }
      // the ticker rotates protocol lines; the real state lives in #status
    };
    new MutationObserver(syncStatus).observe(status, { childList: true, characterData: true, subtree: true });
    syncStatus();
  }
  setInterval(() => {
    if (!tickEl || Date.now() - (tickEl.dataset.at || 0) < 4200) return;
    const d = new Date();
    tickEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${lines[li++ % lines.length]}`;
  }, 2200);

  const space = $("macroSpace");
  if (space && arenaEl) {
    const read = () => {
      const m = /arena (\d+) \/ (\d+) B/.exec(space.textContent);
      if (m) arenaEl.textContent = `${m[1]}/${m[2]}B`;
    };
    new MutationObserver(read).observe(space, { childList: true, characterData: true, subtree: true });
    read();
  }

  /* --------------------------------------------------------- background: 3D mesh */
  // The design's background is a 3D stage of lines: a hexagonal floor grid with
  // a radar ring, a barrier wall that ripples and two wire solids (icosahedron
  // + dodecahedron). Here it runs with no three.js and no CDN: raw WebGL with
  // two minimal shaders. Without WebGL it falls back to the 2D lattice above.
  const canvas = $("gl");

  const hexSegments = (cols, rows, r, plane) => {
    const out = [];
    const dx = r * 1.5, dy = r * Math.sqrt(3);
    const ox = (cols * dx) / 2, oy = (rows * dy) / 2;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const cx = i * dx - ox, cy = j * dy + (i % 2 ? dy / 2 : 0) - oy;
        const pts = [];
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 3 * k;
          pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        for (let k = 0; k < 6; k++) {
          const a = pts[k], b = pts[(k + 1) % 6];
          if (plane === "xz") out.push(a[0], 0, a[1], b[0], 0, b[1]);
          else out.push(a[0], a[1], 0, b[0], b[1], 0);
        }
      }
    }
    return out;
  };

  const polySegments = verts => {
    let min = Infinity;
    for (let i = 0; i < verts.length; i++) {
      for (let k = i + 1; k < verts.length; k++) {
        const d = Math.hypot(verts[i][0] - verts[k][0], verts[i][1] - verts[k][1], verts[i][2] - verts[k][2]);
        if (d > 1e-4 && d < min) min = d;
      }
    }
    const out = [];
    for (let i = 0; i < verts.length; i++) {
      for (let k = i + 1; k < verts.length; k++) {
        const a = verts[i], b = verts[k];
        if (Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - min) < 1e-3) out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
    return out;
  };

  const PHI = (1 + Math.sqrt(5)) / 2;
  const icoVerts = [];
  [[0, 1, PHI], [1, PHI, 0], [PHI, 0, 1]].forEach(([a, b, c]) => {
    [-1, 1].forEach(sa => [-1, 1].forEach(sb => [-1, 1].forEach(sc => {
      icoVerts.push([a * (a ? sa : 1) * (a ? 1 : 1), b * (b ? sb : 1), c * (c ? sc : 1)]);
    })));
  });
  // canonical icosahedron (12 vertices) and dodecahedron (20), scaled
  const ico = [];
  [[0, 1, PHI], [0, 1, -PHI], [0, -1, PHI], [0, -1, -PHI],
   [1, PHI, 0], [1, -PHI, 0], [-1, PHI, 0], [-1, -PHI, 0],
   [PHI, 0, 1], [PHI, 0, -1], [-PHI, 0, 1], [-PHI, 0, -1]]
    .forEach(([x, y, z]) => ico.push([x * 4.6, y * 4.6, z * 4.6]));
  const dod = [];
  const inv = 1 / PHI;
  [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
   [0, inv, PHI], [0, inv, -PHI], [0, -inv, PHI], [0, -inv, -PHI],
   [inv, PHI, 0], [inv, -PHI, 0], [-inv, PHI, 0], [-inv, -PHI, 0],
   [PHI, 0, inv], [PHI, 0, -inv], [-PHI, 0, inv], [-PHI, 0, -inv]]
    .forEach(([x, y, z]) => dod.push([x * 7.2, y * 7.2, z * 7.2]));

  // 4x4 matrices in column order (WebGL)
  const m4 = {
    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
    },
    lookAt(eye, c, up) {
      let zx = eye[0] - c[0], zy = eye[1] - c[1], zz = eye[2] - c[2];
      let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
      let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
      l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      return new Float32Array([
        xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
        -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
        -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
        -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
      ]);
    },
    mul(a, b) {
      const o = new Float32Array(16);
      for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) {
        o[i * 4 + k] = a[k] * b[i * 4] + a[4 + k] * b[i * 4 + 1] + a[8 + k] * b[i * 4 + 2] + a[12 + k] * b[i * 4 + 3];
      }
      return o;
    },
    rotY(a) {
      const c = Math.cos(a), s = Math.sin(a);
      return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
    },
  };

  function startMesh(cv) {
    const gl = cv.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false });
    if (!gl) return false;

    const VS = `attribute vec3 aPos; attribute vec3 aCol; attribute float aKind;
      uniform mat4 uProj, uView; uniform mediump float uTime, uField;
      varying mediump vec3 vP; varying mediump vec3 vC; varying mediump float vK;
      void main(){
        vec3 p = aPos;
        if (aKind > 0.5 && aKind < 1.5) { float d = length(p.xy); p.z += sin(d*0.9 - uTime*4.0)*0.6*uField; }
        vP = p; vC = aCol; vK = aKind;
        gl_Position = uProj * uView * vec4(p, 1.0);
      }`;
    const FS = `precision mediump float;
      varying mediump vec3 vP; varying mediump vec3 vC; varying mediump float vK;
      uniform mediump float uTime;
      void main(){
        float a;
        if (vK < 0.5) {
          float d = length(vP.xz); float r = mod(uTime*11.0, 110.0);
          float ring = exp(-pow(d - r, 2.0)/10.0);
          a = (0.10 + ring*1.1) * (1.0 - smoothstep(24.0, 92.0, d));
        } else if (vK < 1.5) {
          float d = length(vP.xy);
          float w = pow(0.5 + 0.5*sin(d*0.9 - uTime*4.0), 6.0);
          a = (0.09 + w*0.95) * (1.0 - smoothstep(8.0, 13.0, d));
        } else { a = 0.72; }
        gl_FragColor = vec4(vC * a, 1.0);
      }`;

    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return false;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);

    // ---- geometry: floor, wall and solids, each with its per-vertex colour ----
    const GREEN = [0.0, 1.0, 0.26], AMBER = [1.0, 0.69, 0.0], UNIT = [0.36, 0.31, 0.55];
    const pos = [], col = [], kind = [];
    const push = (segs, colour, k, move) => {
      for (let i = 0; i < segs.length; i += 3) {
        const x = segs[i], y = segs[i + 1], z = segs[i + 2];
        const p = move ? move(x, y, z) : [x, y, z];
        pos.push(p[0], p[1], p[2]);
        col.push(colour[0], colour[1], colour[2]);
        kind.push(k);
      }
    };

    push(hexSegments(52, 52, 1.45, "xz"), GREEN, 0, (x, y, z) => [x, -6, z]);
    push(hexSegments(16, 16, 1.55, "xy"), AMBER, 1, (x, y) => {
      const c = Math.cos(0.32), s = Math.sin(0.32);
      return [x * c, y, 8.5 + x * s];
    });
    push(polySegments(ico), GREEN, 2);
    push(polySegments(dod), UNIT, 2);

    const buf = (data, n) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, n);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, data.length / (data.length / 3), gl.FLOAT, false, 0, 0);
      return loc;
    };
    const count = pos.length / 3;
    buf(pos, "aPos");
    buf(col, "aCol");
    buf(kind, "aKind");

    const uProj = gl.getUniformLocation(prog, "uProj");
    const uView = gl.getUniformLocation(prog, "uView");
    const uTime = gl.getUniformLocation(prog, "uTime");
    const uField = gl.getUniformLocation(prog, "uField");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);

    const view = m4.lookAt([0, 6.5, 30], [0, -0.5, 0], [0, 1, 0]);
    let DPR = 1, raf = 0, visible = true;
    const t0 = performance.now();

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 1.5);
      cv.width = Math.round(innerWidth * DPR);
      cv.height = Math.round(innerHeight * DPR);
      cv.style.width = innerWidth + "px";
      cv.style.height = innerHeight + "px";
      gl.viewport(0, 0, cv.width, cv.height);
    }
    resize();
    addEventListener("resize", resize);

    function frame() {
      if (!visible) return;
      raf = requestAnimationFrame(frame);
      const t = (performance.now() - t0) / 1000;
      const proj = m4.perspective(58 * Math.PI / 180, innerWidth / Math.max(1, innerHeight), 0.1, 300);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniformMatrix4fv(uProj, false, proj);
      gl.uniformMatrix4fv(uView, false, m4.mul(view, m4.rotY(REDUCE ? 0.6 : t * 0.05)));
      gl.uniform1f(uTime, REDUCE ? 0 : t);
      gl.uniform1f(uField, 1);
      gl.drawArrays(gl.LINES, 0, count);
    }
    frame();
    document.addEventListener("visibilitychange", () => {
      visible = !document.hidden;
      if (visible) frame(); else cancelAnimationFrame(raf);
    });
    return true;
  }

  // 2D fallback (no WebGL): the flat hexagonal lattice
  function startLattice(cv) {
    document.body.classList.add("nogl");
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext("2d");
    const lattice = document.createElement("canvas");
    const lctx = lattice.getContext("2d");
    let W = 0, H = 0, DPR = 1;
    const R = 22;

    function buildLattice() {
      const w = Math.ceil(W / (R * 3)) + 2, h = Math.ceil(H / (R * 1.5)) + 2;
      lattice.width = W; lattice.height = H;
      lctx.clearRect(0, 0, W, H);
      lctx.strokeStyle = "rgba(0,255,65,0.16)";
      lctx.lineWidth = 1;
      for (let j = 0; j <= h; j++) {
        for (let i = 0; i <= w; i++) {
          const cx = i * R * 3 + (j % 2 ? R * 1.5 : 0), cy = j * R * 1.5;
          lctx.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = Math.PI / 3 * (k + 0.5);
            const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
            k ? lctx.lineTo(x, y) : lctx.moveTo(x, y);
          }
          lctx.closePath();
          lctx.stroke();
        }
      }
    }

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 1.5);
      W = Math.round(innerWidth * DPR); H = Math.round(innerHeight * DPR);
      cv.width = W; cv.height = H;
      cv.style.width = innerWidth + "px"; cv.style.height = innerHeight + "px";
      buildLattice();
    }
    resize();
    addEventListener("resize", resize);

    let visible = true;
    document.addEventListener("visibilitychange", () => { visible = !document.hidden; if (visible) loop(); });
    const t0 = performance.now();
    function loop() {
      if (!visible) return;
      requestAnimationFrame(loop);
      const t = (performance.now() - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = .55;
      ctx.drawImage(lattice, 0, 0);
      if (!REDUCE) {
        const rad = (t * 70) % (Math.max(W, H) * .75);
        ctx.globalAlpha = Math.max(0, .5 - rad / (Math.max(W, H) * .8));
        ctx.strokeStyle = "#00FF41"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(W * .5, H * .45, rad, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    loop();
  }

  if (!(canvas && canvas.getContext && startMesh(canvas))) startLattice(canvas);

  /* ------------------------------------------- snap cutting on enter and glitch */
  function snapIn(sec) {
    if (REDUCE || !sec) return;
    const els = sec.querySelectorAll(".panel, .head-row, .danger, .hazard");
    els.forEach((el, i) => {
      el.style.animationDelay = Math.min(i, 9) * 55 + "ms";
      el.classList.remove("snap");
      void el.offsetWidth;
      el.classList.add("snap");
      el.addEventListener("animationend", () => {
        el.classList.remove("snap");
        el.style.animationDelay = "";
      }, { once: true });
    });
  }

  function cut(els) {
    if (REDUCE) return;
    els.forEach((el, i) => {
      setTimeout(() => {
        el.classList.remove("cutting");
        void el.offsetWidth;
        el.classList.add("cutting");
        el.addEventListener("animationend", () => el.classList.remove("cutting"), { once: true });
      }, i * 60);
    });
  }

  /* --------------------------------------------- floating notice on save */
  // The design's own #alert section, pinned across the full width and centred
  // vertically: not a modal, no dialog box — the page keeps its frame and the
  // band floats over it, dimming the rest with a huge box-shadow.
  const layer = $("alertLayer");
  const aTitle = $("alertTitle"), aClock = $("alertClock"), aNum = $("alertNum");
  const aJp = $("alertJp"), aSub = $("alertSub"), aPat = $("alertPat"), aPatJp = $("alertPatJp");
  const aMsg = $("alertMsg"), aBytes = $("alertBytes"), aBlocks = $("alertBlocks");
  const aDev = $("alertDev"), aSent = $("alertSent"), aResult = $("alertResult");
  const aSectors = $("alertSectors");
  let alertTimer = 0, alertPoll = 0, lastAlertStatus = "", prevState = "";

  const clockNow = () => {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const deviceName = () => {
    const pre = $("device");
    const line = pre ? (pre.textContent || "").trim().split("\n")[0].trim() : "";
    return line && !/^\(|no device|not connected/i.test(line) ? line.slice(0, 42) : "—";
  };

  // the eight regions of the image: the design's districts, with what we know
  let sectorTimer = 0;

  // While the page writes, the eight regions light up one after another: a
  // simulated sweep (the image goes out in one call), and the real result from
  // #status replaces it as soon as it lands.
  function sweepSectors(word) {
    if (!aSectors) return;
    const secs = [...aSectors.querySelectorAll(".sector")];
    clearInterval(sectorTimer);
    secs.forEach(sec => {
      sec.className = "sector";
      const sp = sec.querySelector("span");
      if (sp) sp.textContent = sec.dataset.r;
    });
    let i = 0;
    const tick = () => {
      if (i > 0) {
        const prev = secs[i - 1];
        prev.classList.remove("wrt");
        const sp = prev.querySelector("span");
        if (sp) sp.textContent = `${prev.dataset.r} \u00b7 ${word}`;
      }
      if (i >= secs.length) { clearInterval(sectorTimer); return; }
      const cur = secs[i];
      cur.classList.add("wrt");
      const sp = cur.querySelector("span");
      if (sp) sp.textContent = `${cur.dataset.r} \u00b7 WRITING`;
      i++;
    };
    tick();
    sectorTimer = setInterval(tick, 130);
  }

  function setSectors(kind, word) {
    if (!aSectors) return;
    clearInterval(sectorTimer);
    const label = kind === "fail" ? "FAIL" : kind === "check" ? "CHECK"
      : kind === "ok" ? (word || "SENT") : "\u2014";
    aSectors.querySelectorAll(".sector").forEach(sec => {
      sec.className = "sector";
      sec.classList.toggle("warn", kind === "check");
      sec.classList.toggle("crit", kind === "fail");
      const sp = sec.querySelector("span");
      if (sp) sp.textContent = `${sec.dataset.r} \u00b7 ${label}`;
    });
  }


  // the marquee carries the design's DANGER only when something failed
  const aTrack = $("alertTrack");
  function setMarquee(word, jp) {
    if (!aTrack) return;
    const spans = aTrack.querySelectorAll("span");
    spans.forEach((sp, i) => { sp.textContent = i % 2 ? jp : word; });
  }

  function showAlert(opts) {
    if (!layer) return;
    clearTimeout(alertTimer);
    if (layer.hidden) prevState = document.body.dataset.state || "buttons";
    layer.hidden = false;
    layer.dataset.kind = opts.kind || "wait";
    // the frame goes into the alarm state while the band is up
    document.body.dataset.state = opts.kind === "ok" ? "alarm" : "alarm";
    if (aTitle) aTitle.innerHTML = `${opts.title} \u00b7 <span class="sep">/</span><span id="alertClock">${clockNow()}</span>`;
    if (aNum) aNum.textContent = opts.num || "\u2014";
    if (aJp) aJp.textContent = opts.jp || "\u66f8\u304d\u8fbc\u307f";
    if (aSub) aSub.textContent = opts.sub || "";
    if (aPat) aPat.textContent = opts.pat || "WAIT";
    if (aPatJp) aPatJp.textContent = opts.patJp || "\u51e6\u7406\u4e2d";
    if (aMsg) aMsg.textContent = opts.msg || "";
    setMarquee(opts.kind === "alert" ? "DANGER" : "WRITE", opts.kind === "alert" ? "\u5371\u967a" : "\u66f8\u304d\u8fbc\u307f");
    if (aBytes) aBytes.textContent = opts.bytes || "\u2014";
    if (aBlocks) aBlocks.textContent = opts.blocks || "\u2014";
    if (aDev) aDev.textContent = deviceName();
    if (aSent) aSent.textContent = clockNow();
    if (aResult) aResult.textContent = opts.result || "WAITING";
    if (opts.kind === "wait") sweepSectors("SENT");
    else setSectors(opts.kind === "ok" ? "ok" : opts.kind === "alert" ? "fail" : "wait", opts.word);
    if (aResult) aResult.style.color = opts.kind === "ok" ? "var(--phos)" : "var(--alarm)";
  }

  function hideAlert() {
    if (!layer) return;
    clearTimeout(alertTimer);
    clearInterval(sectorTimer);
    clearInterval(alertPoll);
    layer.hidden = true;
    if (prevState) document.body.dataset.state = prevState;
  }

  const statusEl = $("status");
  // class app.js puts on #status: "ok" / "err" / "warn" (setStatus(text, cls))
  const statusKind = () => (statusEl && statusEl.className) || "";

  const SAVE_ACTIONS = {
    btnApply:      { jp: "\u66f8\u304d\u8fbc\u307f", sub: "image blocks written", patJp: "\u7570\u5e38\u306a\u3057", device: true },
    btnApplyMacros:{ jp: "\u30de\u30af\u30ed", sub: "macro arena written", patJp: "\u7570\u5e38\u306a\u3057", device: true },
    btnApplyLeds:  { jp: "\u767a\u5149", sub: "led bank written", patJp: "\u7570\u5e38\u306a\u3057", device: true },
    btnBackup:     { jp: "\u4fdd\u5b58", sub: "backup file downloaded", patJp: "\u4fdd\u5b58\u6e08\u307f", device: false, done: "DOWNLOADED" },
    btnCopy:       { jp: "\u8ee2\u5199", sub: "json in the clipboard", patJp: "\u8ee2\u5199\u6e08\u307f", device: false, done: "COPIED" },
  };

  Object.keys(SAVE_ACTIONS).forEach(id => {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener("click", () => {
      const meta = SAVE_ACTIONS[id];
      // (a disabled button never fires click: nothing happens, nothing to notice)
      if (!meta.device) {
        // export/copy never touch the mouse: resolved right here
        finishAlert(
          id === "btnBackup" ? "backup file written \u00b7 check your downloads" : "json copied to the clipboard",
          meta, false
        );
        return;
      }
      lastAlertStatus = (statusEl ? statusEl.textContent : "") + "|" + statusKind();
      showAlert({
        kind: "wait",
        title: "Write in progress", titleJp: "\u51e6\u7406\u4e2d",
        jp: meta.jp, sub: meta.sub, pat: "WAIT", patJp: "\u51e6\u7406\u4e2d",
        result: "WAITING",
        msg: statusEl ? statusEl.textContent : "",
      });
      let waited = 0;
      clearInterval(alertPoll);
      alertPoll = setInterval(() => {
        waited += 180;
        const now = (statusEl ? statusEl.textContent : "") + "|" + statusKind();
        if (now !== lastAlertStatus) { finishAlert(statusEl ? statusEl.textContent : "", meta, statusKind() === "err"); return; }
        if (waited > 12000) {
          // do not claim success on silence: say we never heard back
          clearInterval(alertPoll);
          showAlert({
            kind: "alert", title: "No reply from the page", titleJp: "\u5fdc\u7b54\u306a\u3057",
            num: "??", jp: meta.jp, sub: meta.sub, pat: "ALERT", patJp: "\u5fdc\u7b54\u306a\u3057",
            result: "UNKNOWN",
            msg: "the write did not report back within 12 s: check the log before trusting this state.",
          });
          setSectors("check");
          clearTimeout(alertTimer);
          alertTimer = setTimeout(hideAlert, 8000);
        }
      }, 180);
    }, true);
  });

  function finishAlert(text, meta, bad) {
    clearInterval(alertPoll);
    const bytes = /(\d+)\s*bytes/i.exec(text || "");
    const blocks = /(\d+)\s*blocks/i.exec(text || "");
    if (bad === undefined) bad = /error|fail|cannot|refus|denied|unsupported|not connected|no device/i.test(text || "");
    showAlert({
      kind: bad ? "alert" : "ok",
      title: bad ? "Write reported an error" : "Write complete",
      titleJp: bad ? "\u7570\u5e38" : "\u5b8c\u4e86",
      num: bytes ? bytes[1] : blocks ? blocks[1] : bad ? "!!" : "OK",
      jp: meta.jp,
      sub: bytes ? "bytes written" : blocks ? "blocks written" : meta.sub,
      pat: bad ? "ALERT" : "CLEAR",
      patJp: bad ? "\u7570\u5e38" : meta.patJp,
      result: bad ? "FAILED" : meta.done || "WRITTEN",
      word: meta.device ? "SENT" : "EXPORTED",
      bytes: bytes ? bytes[1] : "\u2014",
      blocks: blocks ? blocks[1] : "\u2014",
      msg: text || meta.sub,
    });
    clearTimeout(alertTimer);
    alertTimer = setTimeout(hideAlert, bad ? 8000 : 4600);
  }

  if (layer) {
    // click anywhere on the band dismisses it; the page underneath is untouched
    layer.addEventListener("click", hideAlert);
    addEventListener("keydown", e => { if (e.key === "Escape" && !layer.hidden) { e.preventDefault(); hideAlert(); } });
  }

  /* the macros chapter's cut glitch when the arena changes */
  const macroSec = $("panelMacros");
  if (macroSec && space) {
    let cutT = 0;
    new MutationObserver(() => {
      const now = Date.now();
      if (now - cutT < 700) return;
      cutT = now;
      cut([...macroSec.querySelectorAll(".panel")].slice(0, 2));
    }).observe(space, { childList: true, characterData: true, subtree: true });
  }
})();
