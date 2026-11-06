// Plot 2 — interactive SST trend map.
// Data comes from export_sst_trend.py: for each end year Y, the per-cell linear
// trend of annual SST fitted over 1850..Y (stored as milli-°C/decade, int16).

const MODES = {
  rate:  { limit: 0.1, unit: "°C/decade", fmt: d3.format("+.3f"), label: "Trend" },
  total: { limit: 1.0, unit: "°C",        fmt: d3.format("+.2f"), label: "Trend × years" },
};
const LAT_MIN = -80, LAT_MAX = 63, LON_MIN = 0, LON_MAX = 360;
const M = { left: 34, bottom: 22 };          // room for axis labels around the map
const NOISY_WINDOW = 30;                     // years; shorter fits are mostly noise

const state = { k: 0, mode: "rate", playing: null };
let meta, data, nx, ny, xEdges, yEdges, ctx, mapW, mapH;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

Promise.all([
  fetch("data/sst_meta.json").then((r) => r.json()),
  fetch("data/sst_trend.bin").then((r) => r.arrayBuffer()),
]).then(([m, buf]) => {
  meta = m;
  data = new Int16Array(buf);
  nx = meta.x.length; ny = meta.y.length;
  xEdges = edges(meta.x);
  yEdges = edges(meta.y).map((v) => Math.max(LAT_MIN, Math.min(LAT_MAX, v)));
  init();
}).catch((err) => {
  document.getElementById("note").textContent =
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

function value(k, j, i) {
  const q = data[(k * ny + j) * nx + i];
  if (q === meta.fill) return NaN;
  const rate = q / meta.scale;                       // °C / decade
  return state.mode === "rate" ? rate : (rate / 10) * (meta.years[k] - meta.start_year);
}

function colorScale() {
  const L = MODES[state.mode].limit;
  return d3.scaleLinear()
    .domain([-L, -L / 2, 0, L / 2, L])
    .range(["--div-neg-2", "--div-neg-1", "--div-mid", "--div-pos-1", "--div-pos-2"].map(css))
    .interpolate(d3.interpolateLab)
    .clamp(true);                                     // fixed scale: values beyond ±L saturate
}

function init() {
  const slider = document.getElementById("year");
  slider.min = meta.years[0];
  slider.max = meta.years[meta.years.length - 1];
  slider.value = slider.max;
  state.k = meta.years.length - 1;

  slider.addEventListener("input", () => { stop(); setYear(+slider.value); });
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => { state.mode = r.value; render(); }));
  document.getElementById("play").addEventListener("click", togglePlay);

  ctx = document.getElementById("map").getContext("2d");
  setupMapHover();
  new ResizeObserver(() => { layout(); render(); }).observe(document.querySelector(".map-wrap"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
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
const lonX = () => d3.scaleLinear([LON_MIN, LON_MAX], [0, mapW]);
const latY = () => d3.scaleLinear([LAT_MIN, LAT_MAX], [mapH, 0]);

function layout() {
  const wrap = document.querySelector(".map-wrap");
  mapW = wrap.clientWidth - M.left;
  mapH = Math.round(mapW * (LAT_MAX - LAT_MIN) / (LON_MAX - LON_MIN));
  const canvas = ctx.canvas, dpr = window.devicePixelRatio || 1;
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
  const k = state.k, year = meta.years[k], mode = MODES[state.mode];
  const color = colorScale(), xs = lonX(), ys = latY();

  ctx.fillStyle = css("--land");
  ctx.fillRect(0, 0, mapW, mapH);
  for (let j = 0; j < ny; j++) {
    const y0 = ys(yEdges[j + 1]), h = ys(yEdges[j]) - y0;
    for (let i = 0; i < nx; i++) {
      const v = value(k, j, i);
      if (Number.isNaN(v)) continue;
      ctx.fillStyle = color(v);
      const x0 = xs(xEdges[i]);
      ctx.fillRect(x0, y0, xs(xEdges[i + 1]) - x0 + 0.5, h + 0.5);   // +0.5 hides seams
    }
  }

  const g = globalMean(k);
  document.getElementById("year-label").textContent = year;
  document.getElementById("subtitle").textContent =
    `Linear SST trend, ${meta.start_year}–${year} · global mean ${mode.fmt(g)} ${mode.unit}`;
  const n = year - meta.start_year + 1;
  document.getElementById("note").textContent = n < NOISY_WINDOW
    ? `Only ${n} years in this fit — short-window trends are mostly year-to-year noise, so many cells hit the end of the color scale.`
    : "";

  renderLegend(color);
}

function globalMean(k) {
  const rate = meta.global_mean_trend[k];
  return state.mode === "rate" ? rate : (rate / 10) * (meta.years[k] - meta.start_year);
}

function renderLegend(color) {
  const L = MODES[state.mode].limit, svg = d3.select("#legend");
  const w = svg.node().clientWidth, barH = 12;
  svg.selectAll("*").remove();
  const grad = svg.append("defs").append("linearGradient").attr("id", "legend-grad");
  d3.range(0, 1.0001, 0.1).forEach((t) =>
    grad.append("stop").attr("offset", t).attr("stop-color", color(-L + 2 * L * t)));
  svg.append("rect").attr("width", w).attr("height", barH).attr("rx", 3).attr("fill", "url(#legend-grad)");
  const x = d3.scaleLinear([-L, L], [0, w]);
  const ticks = [-L, -L / 2, 0, L / 2, L];
  const fmt = state.mode === "rate" ? d3.format("+.2~f") : d3.format("+.1~f");
  svg.append("g").selectAll("text").data(ticks).join("text")
    .attr("x", (d) => x(d)).attr("y", barH + 14)
    .attr("text-anchor", (d, i) => (i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"))
    .text((d, i) => (i === 0 ? "≤ " : i === ticks.length - 1 ? "≥ " : "") + (d === 0 ? "0" : fmt(d)));
  svg.append("text").attr("x", w / 2).attr("y", barH + 30).attr("text-anchor", "middle")
    .text(state.mode === "rate" ? "SST trend (°C per decade)" : "Warming implied by trend over the window (°C)");
}

// ---------- map hover ----------
function setupMapHover() {
  const canvas = ctx.canvas, tip = document.getElementById("tooltip");
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    const lon = lonX().invert(e.clientX - r.left), lat = latY().invert(e.clientY - r.top);
    const i = d3.bisectRight(xEdges, lon) - 1, j = d3.bisectRight(yEdges, lat) - 1;
    if (i < 0 || i >= nx || j < 0 || j >= ny) { tip.hidden = true; return; }
    const v = value(state.k, j, i), mode = MODES[state.mode];
    const latTxt = Math.abs(meta.y[j]).toFixed(1) + (meta.y[j] < 0 ? "°S" : "°N");
    tip.innerHTML = `<span class="muted">${meta.x[i].toFixed(0)}°E, ${latTxt}</span><br>` +
      (Number.isNaN(v) ? "land" : `${mode.label} ${meta.start_year}–${meta.years[state.k]}: <strong>${mode.fmt(v)}</strong> ${mode.unit}`);
    tip.hidden = false;
    const wrapW = canvas.parentElement.clientWidth;
    const px = e.clientX - r.left + M.left, py = e.clientY - r.top;
    tip.style.left = Math.min(px + 14, wrapW - tip.offsetWidth - 4) + "px";
    tip.style.top = Math.max(0, py - 44) + "px";
  });
  canvas.addEventListener("pointerleave", () => { tip.hidden = true; });
}
