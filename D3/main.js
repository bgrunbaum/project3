// Plot 2 — interactive SST trend map.
// Data comes from export_sst_trend.py: annual-mean SST for every ocean cell
// (int16, °C * scale). Trends are fitted here, in the browser, so the reader
// can slide a fixed-length window through time or use every year since 1850.

// Color limits are fixed per window length (≈ 2nd–98th percentile of all
// frames), so colors are comparable while the window slides.
const WINDOWS = {
  20:  { rate: 0.4,  total: 0.75 },
  30:  { rate: 0.25, total: 0.75 },
  50:  { rate: 0.15, total: 0.75 },
  all: { rate: 0.1,  total: 1.0 },          // growing window: 1850..end year
};
const MODES = {
  rate:  { unit: "°C/decade", fmt: d3.format("+.3f"), label: "Trend" },
  total: { unit: "°C",        fmt: d3.format("+.2f"), label: "Change implied by trend" },
};
const LAT_MIN = -80, LAT_MAX = 63, LON_MIN = 0, LON_MAX = 360;
const M = { left: 34, bottom: 22 };          // room for axis labels around the map
const NOISY_WINDOW = 30;                     // years; shorter fits are mostly noise

const state = { end: 2014, win: "30", mode: "rate", playing: null, cell: null };  // cell: index j*nx+i
const BASELINE = [1850, 1879];               // anomalies in the time-series panel are relative to this
const SM = { top: 24, right: 12, bottom: 22, left: 46 };   // time-series margins
let series = null;                           // time-series scales + selections (rebuilt on layout/selection)
let meta, sst, nx, ny, nCells, xEdges, yEdges, ctx, mapW, mapH;
let lastPointer = null;
const cache = new Map();                     // "start-end" -> Float32Array of slopes

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const $ = (id) => document.getElementById(id);

Promise.all([
  fetch("data/sst_meta.json").then((r) => r.json()),
  fetch("data/sst_annual.bin").then((r) => r.arrayBuffer()),
]).then(([m, buf]) => {
  meta = m;
  sst = new Int16Array(buf);
  nx = meta.x.length; ny = meta.y.length; nCells = nx * ny;
  xEdges = edges(meta.x);
  yEdges = edges(meta.y).map((v) => Math.max(LAT_MIN, Math.min(LAT_MAX, v)));
  init();
}).catch((err) => {
  $("note").textContent =
    "Could not load data/ — open this page through a local server (python3 -m http.server) rather than as a file.";
  console.error(err);
});

// Cell boundaries from (possibly uneven) cell centers.
function edges(c) {
  const e = [c[0] - (c[1] - c[0]) / 2];
  for (let i = 1; i < c.length; i++) e.push((c[i - 1] + c[i]) / 2);
  e.push(c[c.length - 1] + (c[c.length - 1] - c[c.length - 2]) / 2);
  return e;
}

// ---------- trend fitting ----------
const firstYear = () => meta.years[0];
const lastYear = () => meta.years[meta.years.length - 1];
const winLen = () => (state.win === "all" ? null : +state.win);
const startYear = () => (state.win === "all" ? firstYear() : state.end - winLen() + 1);
const minEnd = () => (state.win === "all" ? firstYear() + 1 : firstYear() + winLen() - 1);

// Least-squares slope (°C/decade) of every cell over years [a, b].
// With t centered on the window, slope = Σ (t - t̄)·v / Σ (t - t̄)².
function slopes(a, b) {
  const key = a + "-" + b;
  if (cache.has(key)) return cache.get(key);
  const k0 = a - firstYear(), n = b - a + 1, tbar = (n - 1) / 2;
  const denom = (n * (n * n - 1)) / 12;
  const out = new Float32Array(nCells).fill(NaN);
  for (let c = 0; c < nCells; c++) {
    if (sst[k0 * nCells + c] === meta.fill) continue;          // land (mask is constant in time)
    let s = 0;
    for (let t = 0; t < n; t++) s += (t - tbar) * sst[(k0 + t) * nCells + c];
    out[c] = (s / denom / meta.scale) * 10;
  }
  if (cache.size > 400) cache.clear();
  cache.set(key, out);
  return out;
}

function globalSlope(a, b) {
  const g = meta.global_mean_sst.slice(a - firstYear(), b - firstYear() + 1);
  const n = g.length, tbar = (n - 1) / 2;
  return (d3.sum(g, (v, t) => (t - tbar) * v) / ((n * (n * n - 1)) / 12)) * 10;
}

// Convert a °C/decade slope to the selected unit.
function toUnit(rate) {
  return state.mode === "rate" ? rate : (rate / 10) * (state.end - startYear());
}

function colorScale() {
  const L = WINDOWS[state.win][state.mode];
  return d3.scaleLinear()
    .domain([-L, -L / 2, 0, L / 2, L])
    .range(["--div-neg-2", "--div-neg-1", "--div-mid", "--div-pos-1", "--div-pos-2"].map(css))
    .interpolate(d3.interpolateLab)
    .clamp(true);                                     // fixed scale: values beyond ±L saturate
}

// ---------- controls ----------
function init() {
  const slider = $("year");
  slider.max = lastYear();
  state.end = lastYear();
  syncSlider();

  slider.addEventListener("input", () => { stop(); state.end = +slider.value; render(); });
  $("window").addEventListener("change", (e) => {
    state.win = e.target.value;
    syncSlider();
    render();
  });
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => { state.mode = r.value; render(); }));
  $("play").addEventListener("click", togglePlay);

  $("clear-cell").addEventListener("click", () => selectCell(null));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") selectCell(null); });

  ctx = $("map").getContext("2d");
  setupMapHover();
  new ResizeObserver(() => { layout(); buildSeries(); render(); }).observe(document.querySelector(".map-wrap"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
}

function syncSlider() {
  const slider = $("year");
  slider.min = minEnd();
  state.end = Math.max(minEnd(), Math.min(lastYear(), state.end));
  slider.value = state.end;
}

function togglePlay() {
  if (state.playing) return stop();
  if (state.end >= lastYear()) state.end = minEnd();
  $("play").textContent = "❚❚";
  $("play").setAttribute("aria-label", "Pause");
  render();
  state.playing = d3.interval(() => {
    if (state.end >= lastYear()) return stop();
    state.end += 1;
    $("year").value = state.end;
    render();
  }, 100);
}
function stop() {
  if (!state.playing) return;
  state.playing.stop(); state.playing = null;
  $("play").textContent = "▶";
  $("play").setAttribute("aria-label", "Play");
}

// ---------- layout ----------
const lonX = () => d3.scaleLinear([LON_MIN, LON_MAX], [0, mapW]);
const latY = () => d3.scaleLinear([LAT_MIN, LAT_MAX], [mapH, 0]);

function layout() {
  const wrap = document.querySelector(".map-wrap");
  mapW = wrap.clientWidth - M.left;
  mapH = Math.round(mapW * (LAT_MAX - LAT_MIN) / (LON_MAX - LON_MIN));
  const canvas = ctx.canvas, dpr = window.devicePixelRatio || 1;
  canvas.style.marginLeft = M.left + "px";
  canvas.style.width = mapW + "px"; canvas.style.height = mapH + "px";
  canvas.width = Math.round(mapW * dpr); canvas.height = Math.round(mapH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wrap.style.height = mapH + M.bottom + "px";

  const svg = d3.select("#map-axes");
  svg.selectAll("*").remove();
  const g = svg.append("g").attr("transform", `translate(${M.left},0)`);
  const xs = lonX(), ys = latY();
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${mapH})`)
    .call(d3.axisBottom(xs).tickValues(d3.range(0, 361, mapW < 500 ? 120 : 60)).tickFormat((d) => d + "°E").tickSizeOuter(0));
  g.append("g").attr("class", "axis")
    .call(d3.axisLeft(ys).tickValues([-60, -30, 0, 30, 60]).tickFormat((d) => (d === 0 ? "0°" : Math.abs(d) + (d < 0 ? "°S" : "°N"))).tickSizeOuter(0));
}

// ---------- render ----------
function render() {
  if (!mapW) return;
  const a = startYear(), b = state.end, mode = MODES[state.mode];
  const s = slopes(a, b), color = colorScale(), xs = lonX(), ys = latY();

  ctx.fillStyle = css("--land");
  ctx.fillRect(0, 0, mapW, mapH);
  for (let j = 0; j < ny; j++) {
    const y0 = ys(yEdges[j + 1]), h = ys(yEdges[j]) - y0;
    for (let i = 0; i < nx; i++) {
      const v = s[j * nx + i];
      if (Number.isNaN(v)) continue;
      ctx.fillStyle = color(toUnit(v));
      const x0 = xs(xEdges[i]);
      ctx.fillRect(x0, y0, xs(xEdges[i + 1]) - x0 + 0.5, h + 0.5);   // +0.5 hides seams
    }
  }

  const n = b - a + 1;
  $("year-label").textContent = `${a}–${b}`;
  $("subtitle").textContent =
    `Linear SST trend over ${state.win === "all" ? "every year since 1850" : `a ${n}-year window`}, ${a}–${b} · ` +
    `global mean ${mode.fmt(toUnit(globalSlope(a, b)))} ${mode.unit}`;
  $("note").textContent = state.win === "all" && n < NOISY_WINDOW
    ? `Only ${n} years in this fit — short-window trends are mostly year-to-year noise, so many cells hit the end of the color scale.`
    : "";

  renderLegend(color);
  renderMarker();
  updateSeries();
  if (lastPointer) showTooltip(lastPointer);           // keep tooltip in sync during play / toggles
}

// Set the window's last year (clamped) and redraw. Used by the slider, play, and the time series.
function setEnd(y) {
  state.end = Math.max(minEnd(), Math.min(lastYear(), Math.round(y)));
  $("year").value = state.end;
  render();
}

function renderLegend(color) {
  const L = WINDOWS[state.win][state.mode], svg = d3.select("#legend");
  const w = svg.node().clientWidth, barH = 12;
  svg.selectAll("*").remove();
  const grad = svg.append("defs").append("linearGradient").attr("id", "legend-grad");
  d3.range(0, 1.0001, 0.1).forEach((t) =>
    grad.append("stop").attr("offset", t).attr("stop-color", color(-L + 2 * L * t)));
  svg.append("rect").attr("width", w).attr("height", barH).attr("rx", 3).attr("fill", "url(#legend-grad)");
  const x = d3.scaleLinear([-L, L], [0, w]);
  const ticks = [-L, -L / 2, 0, L / 2, L];
  const fmt = d3.format("+.3~f");
  svg.append("g").selectAll("text").data(ticks).join("text")
    .attr("x", (d) => x(d)).attr("y", barH + 14)
    .attr("text-anchor", (d, i) => (i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"))
    .text((d, i) => (i === 0 ? "≤ " : i === ticks.length - 1 ? "≥ " : "") + (d === 0 ? "0" : fmt(d)));
  svg.append("text").attr("x", w / 2).attr("y", barH + 30).attr("text-anchor", "middle")
    .text(state.mode === "rate" ? "SST trend (°C per decade)" : "Warming implied by trend over the window (°C)");
}

// ---------- map hover / click ----------
function setupMapHover() {
  const canvas = ctx.canvas;
  canvas.addEventListener("pointermove", (e) => { lastPointer = e; showTooltip(e); });
  canvas.addEventListener("pointerleave", () => { lastPointer = null; $("tooltip").hidden = true; });
  canvas.addEventListener("click", (e) => {
    const hit = cellAt(e);
    // Ocean cell → select it; land or the same cell again → back to the global mean.
    const c = hit && sst[hit.j * nx + hit.i] !== meta.fill ? hit.j * nx + hit.i : null;
    selectCell(c === state.cell ? null : c);
  });
}

function cellAt(e) {
  const r = ctx.canvas.getBoundingClientRect();
  const lon = lonX().invert(e.clientX - r.left), lat = latY().invert(e.clientY - r.top);
  const i = d3.bisectRight(xEdges, lon) - 1, j = d3.bisectRight(yEdges, lat) - 1;
  return i < 0 || i >= nx || j < 0 || j >= ny ? null : { i, j };
}

const latLabel = (j) => Math.abs(meta.y[j]).toFixed(0) + (meta.y[j] < 0 ? "°S" : "°N");
const cellLabel = (c) => `${meta.x[c % nx].toFixed(0)}°E, ${latLabel(Math.floor(c / nx))}`;

function selectCell(c) {
  if (c === state.cell) return;
  state.cell = c;
  $("clear-cell").hidden = c === null;
  $("series-title").textContent = c === null ? "Global-mean SST" : `SST at ${cellLabel(c)}`;
  buildSeries();
  render();
}

function renderMarker() {
  const svg = d3.select("#map-axes");
  svg.selectAll(".marker-g").remove();
  if (state.cell === null) return;
  const i = state.cell % nx, j = Math.floor(state.cell / nx), xs = lonX(), ys = latY();
  const x = M.left + (xs(xEdges[i]) + xs(xEdges[i + 1])) / 2, y = (ys(yEdges[j]) + ys(yEdges[j + 1])) / 2;
  const g = svg.append("g").attr("class", "marker-g");
  g.append("circle").attr("class", "marker-halo").attr("cx", x).attr("cy", y).attr("r", 7);
  g.append("circle").attr("class", "marker").attr("cx", x).attr("cy", y).attr("r", 7);
}

function showTooltip(e) {
  const canvas = ctx.canvas, tip = $("tooltip");
  const r = canvas.getBoundingClientRect();
  const hit = cellAt(e);
  if (!hit) { tip.hidden = true; return; }
  const { i, j } = hit;
  const a = startYear(), b = state.end;
  const v = slopes(a, b)[j * nx + i], mode = MODES[state.mode];
  const latTxt = Math.abs(meta.y[j]).toFixed(1) + (meta.y[j] < 0 ? "°S" : "°N");
  tip.innerHTML = `<span class="muted">${meta.x[i].toFixed(0)}°E, ${latTxt}</span><br>` +
    (Number.isNaN(v) ? "land" : `${mode.label}, ${a}–${b}: <strong>${mode.fmt(toUnit(v))}</strong> ${mode.unit}` +
      (state.cell === j * nx + i ? "" : `<br><span class="muted">Click to see this cell's yearly SST</span>`));
  tip.hidden = false;
  const wrapW = canvas.parentElement.clientWidth;
  const px = e.clientX - r.left + M.left, py = e.clientY - r.top;
  tip.style.left = Math.min(px + 14, wrapW - tip.offsetWidth - 4) + "px";
  tip.style.top = Math.max(0, py - 44) + "px";
}

// ---------- linked time series ----------
// Shows the annual SST behind the map's colors: the selected cell (or the global mean),
// the current window shaded, and the least-squares line whose slope sets the map color.

function anomalies(values) {
  const base = d3.mean(values.slice(BASELINE[0] - firstYear(), BASELINE[1] - firstYear() + 1));
  return values.map((v) => v - base);
}
const globalSeries = () => anomalies(meta.global_mean_sst);
const cellSeries = (c) => anomalies(meta.years.map((_, k) => sst[k * nCells + c] / meta.scale));

// Fitted line over [a, b] as two endpoints, plus its slope in °C/decade.
function fitLine(vals, a, b) {
  const w = vals.slice(a - firstYear(), b - firstYear() + 1), n = w.length, tbar = (n - 1) / 2;
  const slope = d3.sum(w, (v, t) => (t - tbar) * v) / ((n * (n * n - 1)) / 12);   // °C / year
  const mid = d3.mean(w);
  return { x1: a, y1: mid - slope * tbar, x2: b, y2: mid + slope * tbar, rate: slope * 10 };
}

// Static parts (axes, lines): rebuilt only when the size or the selected cell changes,
// so dragging the window does not recreate the element being dragged.
function buildSeries() {
  if (!meta || !mapW) return;
  const svg = d3.select("#series");
  svg.selectAll("*").remove();
  const W = svg.node().clientWidth, H = svg.node().clientHeight;
  const iw = W - SM.left - SM.right, ih = H - SM.top - SM.bottom;
  const glob = globalSeries();
  const main = state.cell === null ? glob : cellSeries(state.cell);
  const ref = state.cell === null ? null : glob;

  const x = d3.scaleLinear([firstYear(), lastYear()], [0, iw]);
  const y = d3.scaleLinear(d3.extent([...main, ...(ref || []), 0]), [ih, 0]).nice();
  const g = svg.append("g").attr("transform", `translate(${SM.left},${SM.top})`);

  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(x).ticks(iw < 450 ? 4 : 8).tickFormat(d3.format("d")).tickSizeOuter(0));
  g.append("g").attr("class", "axis")
    .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format("+.1~f")).tickSizeOuter(0));
  g.append("text").attr("class", "ylabel").attr("x", -SM.left).attr("y", -SM.top + 2).attr("dy", "0.7em")
    .text(`°C vs ${BASELINE[0]}–${BASELINE[1]}`);
  g.append("line").attr("class", "zero").attr("x1", 0).attr("x2", iw).attr("y1", y(0)).attr("y2", y(0));

  // Background catches clicks: clicking a year moves the window there.
  g.append("rect").attr("class", "bg").attr("width", iw).attr("height", ih)
    .on("click", (e) => {
      stop();
      const yr = x.invert(d3.pointer(e)[0]);
      setEnd(state.win === "all" ? yr : yr + winLen() / 2);
    });

  const band = g.append("rect").attr("class", "band").attr("y", 0).attr("height", ih);
  const line = d3.line().x((_, k) => x(firstYear() + k)).y((v) => y(v));
  if (ref) g.append("path").attr("class", "line-ref").attr("d", line(ref)).attr("pointer-events", "none");
  g.append("path").attr("class", "line-main").attr("d", line(main)).attr("pointer-events", "none");
  const dots = g.append("g").attr("pointer-events", "none");
  const fitRef = ref ? g.append("line").attr("class", "fit-ref").attr("pointer-events", "none") : null;
  const fit = g.append("line").attr("class", "fit").attr("pointer-events", "none");

  // Legend key: one row above the plot area, right-aligned, so it never covers data.
  const key = g.append("g").attr("class", "key").attr("transform", `translate(${iw},${-SM.top + 8})`);
  const items = [[state.cell === null ? "global mean" : "this cell", "line-main"], ...(ref ? [["global mean", "line-ref"]] : []), ["trend over window", "fit"]];
  let kx = 0;
  items.reverse().forEach(([label, cls]) => {
    const t = key.append("text").attr("x", kx).attr("dy", "0.32em").attr("text-anchor", "end").text(label);
    kx -= t.node().getComputedTextLength() + 6;
    key.append("line").attr("class", cls).attr("x1", kx - 16).attr("x2", kx);
    kx -= 30;
  });

  // Dragging the band slides the window (fixed length, so this only moves the end year).
  let grab = 0;
  band.call(d3.drag()
    .on("start", (e) => { stop(); grab = x.invert(e.x) - state.end; })
    .on("drag", (e) => { const yr = x.invert(e.x) - grab; if (Math.round(yr) !== state.end) setEnd(yr); }));

  series = { x, y, band, dots, fit, fitRef, main, ref, ih };
}

// Dynamic parts: window band, dots inside it, fitted line(s), subtitle. Runs every frame.
function updateSeries() {
  if (!series) buildSeries();
  if (!series) return;
  const { x, y, band, dots, fit, fitRef, main, ref } = series;
  const a = startYear(), b = state.end;
  band.attr("x", x(a)).attr("width", Math.max(1, x(b) - x(a)));

  const inWin = main.map((v, k) => [firstYear() + k, v]).filter(([yr]) => yr >= a && yr <= b);
  dots.selectAll("circle").data(inWin).join("circle").attr("class", "dot")
    .attr("r", inWin.length > 60 ? 1.5 : 2.5).attr("cx", (d) => x(d[0])).attr("cy", (d) => y(d[1]));

  const f = fitLine(main, a, b);
  fit.attr("x1", x(f.x1)).attr("y1", y(f.y1)).attr("x2", x(f.x2)).attr("y2", y(f.y2));
  let sub = `Trend ${a}–${b}: ${d3.format("+.3f")(f.rate)} °C/decade`;
  if (ref) {
    const r = fitLine(ref, a, b);
    fitRef.attr("x1", x(r.x1)).attr("y1", y(r.y1)).attr("x2", x(r.x2)).attr("y2", y(r.y2));
    sub += ` · global mean ${d3.format("+.3f")(r.rate)} °C/decade`;
  }
  $("series-sub").textContent = sub;
}
