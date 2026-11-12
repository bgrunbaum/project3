// Plot 2 — interactive SST map: sea-surface temperature in the selected year.
// Data comes from export_sst_trend.py: annual-mean SST per cell (int16, centi-°C).

const MODES = {
  temp: { lo: -2, hi: 32, fmt: d3.format(".1f"), label: "SST",
          legend: "Sea-surface temperature (°C)", ticks: [0, 10, 20, 30] },
  anom: { lo: -2, hi: 2, fmt: d3.format("+.2f"), label: "Change vs 1850–1900",
          legend: "Change from 1850–1900 average (°C)", ticks: [-2, -1, 0, 1, 2] },
};
const LAT_MIN = -80, LAT_MAX = 63, LON_MIN = 0, LON_MAX = 360;
const M = { left: 34, bottom: 22 };          // room for axis labels around the map
const BASE_YEARS = 51;                       // 1850–1900 baseline for "change" mode
const LUT_N = 512;

const state = { k: 0, mode: "temp", playing: null };
let meta, data, nx, ny, xEdges, yEdges, ctx, mapW, mapH;
let base, baseGlobal, field, lut, land, img, cols, rows, lastPtr = null;
let zoom, view = d3.zoomIdentity, gx, gy, rafId = 0, quiet = false;   // zoom/pan state

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

Promise.all([
  fetch("data/sst_meta.json").then((r) => r.json()),
  fetch("data/sst.bin").then((r) => r.arrayBuffer()),
]).then(([m, buf]) => {
  if (!m.global_mean || !m.years) throw new Error("sst_meta.json is in the old format; re-run export_sst_trend.py");
  meta = m;
  data = new Int16Array(buf);
  nx = meta.x.length; ny = meta.y.length;
  if (data.length !== meta.years.length * ny * nx)
    throw new Error(`sst.bin has ${data.length} values, expected ${meta.years.length * ny * nx}; re-run export_sst_trend.py`);
  xEdges = edges(meta.x);
  yEdges = edges(meta.y).map((v) => Math.max(LAT_MIN, Math.min(LAT_MAX, v)));
  field = new Float32Array(nx * ny);
  computeBase();
  init();
}).catch((err) => {
  document.getElementById("note").textContent =
    "Could not load the data: " + err.message +
    " (Open the page through a local server, e.g. python3 -m http.server, not as a file.)";
  console.error(err);
});

// Cell boundaries from (possibly uneven) cell centers.
function edges(c) {
  const e = [c[0] - (c[1] - c[0]) / 2];
  for (let i = 1; i < c.length; i++) e.push((c[i - 1] + c[i]) / 2);
  e.push(c[c.length - 1] + (c[c.length - 1] - c[c.length - 2]) / 2);
  return e;
}

// Per-cell mean of the first BASE_YEARS years, used by "change" mode.
function computeBase() {
  const n = nx * ny;
  base = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    let s = 0, cnt = 0;
    for (let k = 0; k < BASE_YEARS; k++) {
      const q = data[k * n + c];
      if (q !== meta.fill) { s += q; cnt++; }
    }
    base[c] = cnt ? s / cnt / meta.scale : NaN;
  }
  baseGlobal = d3.mean(meta.global_mean.slice(0, BASE_YEARS));
}

function value(k, j, i) {
  const c = j * nx + i, q = data[k * nx * ny + c];
  if (q === meta.fill) return NaN;
  const t = q / meta.scale;                          // °C
  return state.mode === "temp" ? t : t - base[c];
}

function colorScale() {
  const m = MODES[state.mode];
  if (state.mode === "temp") return d3.scaleSequential(d3.interpolateTurbo).domain([m.lo, m.hi]).clamp(true);
  const L = m.hi;
  return d3.scaleLinear()
    .domain([-L, -L / 2, 0, L / 2, L])
    .range(["--div-neg-2", "--div-neg-1", "--div-mid", "--div-pos-1", "--div-pos-2"].map(css))
    .interpolate(d3.interpolateLab)
    .clamp(true);
}

// Precomputed colour table: rebuilt only when mode or theme changes, not per frame.
function buildLut() {
  const m = MODES[state.mode], c = colorScale();
  lut = new Uint8ClampedArray(LUT_N * 3);
  for (let n = 0; n < LUT_N; n++) {
    const col = d3.rgb(c(m.lo + ((m.hi - m.lo) * n) / (LUT_N - 1)));
    lut[3 * n] = col.r; lut[3 * n + 1] = col.g; lut[3 * n + 2] = col.b;
  }
  const l = d3.rgb(css("--land"));
  land = [l.r, l.g, l.b];
}

function init() {
  const slider = document.getElementById("year");
  slider.min = meta.years[0];
  slider.max = meta.years[meta.years.length - 1];
  slider.value = slider.max;
  state.k = meta.years.length - 1;

  slider.addEventListener("input", () => { stop(); setYear(+slider.value); });
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => { state.mode = r.value; buildLut(); renderLegend(); render(); }));
  document.getElementById("play").addEventListener("click", togglePlay);

  ctx = document.getElementById("map").getContext("2d");
  zoom = d3.zoom().scaleExtent([1, 10])
    .filter((e) => (e.type === "wheel" ? e.ctrlKey || e.metaKey : !e.button))   // plain scroll still scrolls the page
    .on("zoom", zoomed);
  const canvasSel = d3.select(ctx.canvas).call(zoom);
  const zoomBy = (f) => () => canvasSel.transition().duration(250).call(zoom.scaleBy, f);
  document.getElementById("zoom-in").addEventListener("click", zoomBy(1.6));
  document.getElementById("zoom-out").addEventListener("click", zoomBy(1 / 1.6));
  document.getElementById("zoom-reset").addEventListener("click", () =>
    canvasSel.transition().duration(250).call(zoom.transform, d3.zoomIdentity));
  buildLut();
  setupMapHover();
  new ResizeObserver(() => { layout(); renderLegend(); render(); })
    .observe(document.querySelector(".map-wrap"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    buildLut(); renderLegend(); render();
  });
}

function setYear(y) {
  state.k = Math.max(0, Math.min(meta.years.length - 1, y - meta.years[0]));
  document.getElementById("year").value = meta.years[state.k];
  render();
}

function togglePlay() {
  if (state.playing) return stop();
  if (state.k === meta.years.length - 1) state.k = 0;
  document.getElementById("play").textContent = "❚❚";
  document.getElementById("play").setAttribute("aria-label", "Pause");
  state.playing = d3.interval(() => {
    if (state.k >= meta.years.length - 1) return stop();
    setYear(meta.years[state.k + 1]);
  }, 80);
}
function stop() {
  if (!state.playing) return;
  state.playing.stop(); state.playing = null;
  document.getElementById("play").textContent = "▶";
  document.getElementById("play").setAttribute("aria-label", "Play");
}

// ---------- layout ----------
const lonX = () => view.rescaleX(d3.scaleLinear([LON_MIN, LON_MAX], [0, mapW]));
const latY = () => view.rescaleY(d3.scaleLinear([LAT_MIN, LAT_MAX], [mapH, 0]));
const latLabel = (d) => (d === 0 ? "0°" : Math.abs(d) + (d < 0 ? "°S" : "°N"));

// For each output pixel along one axis: the two neighbouring cell centres, the
// blend fraction between them, and the nearest cell (used for the land mask).
function sampleMap(n, coordAt, centers) {
  const i0 = new Int16Array(n), i1 = new Int16Array(n), t = new Float32Array(n), nn = new Int16Array(n);
  const last = centers.length - 1;
  for (let p = 0; p < n; p++) {
    const v = coordAt(p);
    const i = Math.max(0, Math.min(last - 1, d3.bisectRight(centers, v) - 1));
    const f = Math.max(0, Math.min(1, (v - centers[i]) / (centers[i + 1] - centers[i])));
    i0[p] = i; i1[p] = i + 1; t[p] = f; nn[p] = f < 0.5 ? i : i + 1;
  }
  return { i0, i1, t, nn };
}

function layout() {
  const wrap = document.querySelector(".map-wrap");
  mapW = wrap.clientWidth - M.left;
  mapH = Math.round(mapW * (LAT_MAX - LAT_MIN) / (LON_MAX - LON_MIN));
  const canvas = ctx.canvas, dpr = window.devicePixelRatio || 1;
  canvas.style.width = mapW + "px"; canvas.style.height = mapH + "px";
  canvas.width = Math.round(mapW * dpr); canvas.height = Math.round(mapH * dpr);
  wrap.style.height = mapH + M.bottom + "px";

  img = ctx.createImageData(canvas.width, canvas.height);

  // A resize invalidates the pixel-space transform, so go back to the full map.
  zoom.extent([[0, 0], [mapW, mapH]]).translateExtent([[0, 0], [mapW, mapH]]);
  quiet = true;
  d3.select(canvas).call(zoom.transform, d3.zoomIdentity);
  quiet = false;
  view = d3.zoomIdentity;

  const svg = d3.select("#map-axes");
  svg.selectAll("*").remove();
  const g = svg.append("g").attr("transform", `translate(${M.left},0)`);
  gx = g.append("g").attr("class", "axis").attr("transform", `translate(0,${mapH})`);
  gy = g.append("g").attr("class", "axis");
  updateView();
}

// Rebuild the pixel -> cell maps and the axes for the current zoom/pan.
function updateView() {
  const W = img.width, H = img.height, xs = lonX(), ys = latY();
  cols = sampleMap(W, (p) => xs.invert(((p + 0.5) / W) * mapW), meta.x);
  rows = sampleMap(H, (p) => ys.invert(((p + 0.5) / H) * mapH), meta.y);
  gx.call(d3.axisBottom(xs).ticks(Math.max(2, Math.round(mapW / 90))).tickFormat((d) => d + "°E").tickSizeOuter(0));
  gy.call(d3.axisLeft(ys).ticks(Math.max(2, Math.round(mapH / 50))).tickFormat(latLabel).tickSizeOuter(0));
}

// Zoom events fire faster than we can repaint, so coalesce them to one paint per frame.
function zoomed(e) {
  if (quiet) return;
  view = e.transform;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    updateView();
    paint(MODES[state.mode]);
    if (lastPtr) showTip(lastPtr);
  });
}

// ---------- render ----------
function render() {
  if (!mapW || !img) return;
  const k = state.k, year = meta.years[k], m = MODES[state.mode];

  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) field[j * nx + i] = value(k, j, i);
  paint(m);

  const g = meta.global_mean[k] - (state.mode === "temp" ? 0 : baseGlobal);
  document.getElementById("year-label").textContent = year;
  document.getElementById("subtitle").textContent = state.mode === "temp"
    ? `Sea-surface temperature in ${year} · mapped-ocean mean ${m.fmt(g)} °C`
    : `${year} compared with the 1850–1900 average · mapped-ocean mean ${m.fmt(g)} °C`;
  document.getElementById("note").textContent = "";

  if (lastPtr) showTip(lastPtr);                     // keep tooltip in sync while animating
}

// Bilinear interpolation between cell centres, one output pixel at a time.
// Land is masked by the nearest cell so coastlines stay crisp.
function paint(m) {
  const px = img.data, W = img.width, H = img.height;
  const scale = (LUT_N - 1) / (m.hi - m.lo);
  let o = 0;
  for (let y = 0; y < H; y++) {
    const r0 = rows.i0[y] * nx, r1 = rows.i1[y] * nx, rn = rows.nn[y] * nx, ty = rows.t[y];
    for (let x = 0; x < W; x++, o += 4) {
      const i0 = cols.i0[x], i1 = cols.i1[x], tx = cols.t[x];
      if (Number.isNaN(field[rn + cols.nn[x]])) {
        px[o] = land[0]; px[o + 1] = land[1]; px[o + 2] = land[2]; px[o + 3] = 255;
        continue;
      }
      let s = 0, sw = 0, w;
      const a = field[r0 + i0], b = field[r0 + i1], c = field[r1 + i0], d = field[r1 + i1];
      w = (1 - tx) * (1 - ty); if (a === a) { s += a * w; sw += w; }   // a===a skips NaN
      w = tx * (1 - ty);       if (b === b) { s += b * w; sw += w; }
      w = (1 - tx) * ty;       if (c === c) { s += c * w; sw += w; }
      w = tx * ty;             if (d === d) { s += d * w; sw += w; }
      let n = Math.round((s / sw - m.lo) * scale);
      n = n < 0 ? 0 : n > LUT_N - 1 ? LUT_N - 1 : n;
      px[o] = lut[3 * n]; px[o + 1] = lut[3 * n + 1]; px[o + 2] = lut[3 * n + 2]; px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function renderLegend() {
  const m = MODES[state.mode], color = colorScale(), svg = d3.select("#legend");
  const w = svg.node().clientWidth, barH = 12;
  svg.selectAll("*").remove();
  const grad = svg.append("defs").append("linearGradient").attr("id", "legend-grad");
  d3.range(0, 1.0001, 0.05).forEach((t) =>
    grad.append("stop").attr("offset", t).attr("stop-color", color(m.lo + (m.hi - m.lo) * t)));
  svg.append("rect").attr("width", w).attr("height", barH).attr("rx", 3).attr("fill", "url(#legend-grad)");
  const x = d3.scaleLinear([m.lo, m.hi], [0, w]);
  svg.append("g").selectAll("text").data(m.ticks).join("text")
    .attr("x", (d) => x(d)).attr("y", barH + 14).attr("text-anchor", "middle")
    .text((d) => (state.mode === "anom" && d > 0 ? "+" : "") + d);
  svg.append("text").attr("x", w / 2).attr("y", barH + 30).attr("text-anchor", "middle").text(m.legend);
}

// ---------- map hover ----------
function showTip(e) {
  const canvas = ctx.canvas, tip = document.getElementById("tooltip");
  const r = canvas.getBoundingClientRect();
  const lon = lonX().invert(e.clientX - r.left), lat = latY().invert(e.clientY - r.top);
  const i = d3.bisectRight(xEdges, lon) - 1, j = d3.bisectRight(yEdges, lat) - 1;
  if (i < 0 || i >= nx || j < 0 || j >= ny) { tip.hidden = true; return; }
  const v = value(state.k, j, i), m = MODES[state.mode];
  const latTxt = Math.abs(meta.y[j]).toFixed(1) + (meta.y[j] < 0 ? "°S" : "°N");
  tip.innerHTML = `<span class="muted">${meta.x[i].toFixed(0)}°E, ${latTxt}</span><br>` +
    (Number.isNaN(v) ? "land" : `${m.label}, ${meta.years[state.k]}: <strong>${m.fmt(v)}</strong> °C`);
  tip.hidden = false;
  const wrapW = canvas.parentElement.clientWidth;
  const px = e.clientX - r.left + M.left, py = e.clientY - r.top;
  tip.style.left = Math.min(px + 14, wrapW - tip.offsetWidth - 4) + "px";
  tip.style.top = Math.max(0, py - 44) + "px";
}

function setupMapHover() {
  const canvas = ctx.canvas, tip = document.getElementById("tooltip");
  canvas.addEventListener("pointermove", (e) => { lastPtr = e; showTip(e); });
  canvas.addEventListener("pointerleave", () => { lastPtr = null; tip.hidden = true; });
}