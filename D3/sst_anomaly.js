// Ocean surface warming map: SST anomaly vs 1850–1900, with zoom, pan and an averaging window.
// Data comes from export_sst_anomaly.py: int16 grid (years × lat × lon) in 0.01 °C units.

const LIMIT = 2;                          // °C: fixed color range for every year
const M = { left: 34, bottom: 22 };       // room for axis labels around the map
const MAP_HEIGHT_FRACTION = 0.9;         // the map takes about this much of the window height
const state = { k: 0, win: 10, playing: null, t: d3.zoomIdentity };   // k = year index, win = years averaged, t = zoom transform

let meta, data, nx, ny, ctx, mapW, mapH, colors, tlX, tlY, zoom, off, offCtx;
let frame, frameKey = "";                 // the averaged values currently on screen

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = d3.format("+.2f");

Promise.all([
  fetch("data/sst_anom_meta.json").then((r) => r.json()),
  fetch("data/sst_anom.bin").then((r) => r.arrayBuffer()),
]).then(([m, buf]) => {
  meta = m;
  data = new Int16Array(buf);
  nx = meta.lon.length;
  ny = meta.lat.length;
  init();
}).catch((err) => {
  document.getElementById("note").textContent =
    "Could not load data/. Run export_sst_anomaly.py, then open this page through a local server (python3 -m http.server).";
  console.error(err);
});

function init() {
  const slider = document.getElementById("year");
  slider.min = meta.years[0];
  slider.max = meta.years[meta.years.length - 1];
  slider.value = slider.max;
  state.k = meta.years.length - 1;

  slider.addEventListener("input", () => { stop(); setYear(+slider.value); });
  document.getElementById("play").addEventListener("click", togglePlay);
  document.querySelectorAll('input[name="win"]').forEach((r) =>
    r.addEventListener("change", () => { state.win = +r.value; render(); }));
  state.win = +document.querySelector('input[name="win"]:checked').value;

  ctx = document.getElementById("map").getContext("2d");
  off = document.createElement("canvas");               // tiny canvas: one pixel per grid cell
  off.width = nx; off.height = ny;
  offCtx = off.getContext("2d");

  setupZoom();
  setupHover();

  const refresh = () => { layout(); render(); };
  new ResizeObserver(refresh).observe(document.getElementById("map-wrap"));
  window.addEventListener("resize", refresh);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refresh);
}

// ---------- year control ----------
function setYear(y) {
  state.k = Math.max(0, Math.min(meta.years.length - 1, y - meta.years[0]));
  document.getElementById("year").value = meta.years[state.k];
  render();
}

function togglePlay() {
  if (state.playing) return stop();
  if (state.k === meta.years.length - 1) state.k = 0;
  document.getElementById("play").textContent = "❚❚";
  state.playing = d3.interval(() => {
    if (state.k >= meta.years.length - 1) return stop();
    setYear(meta.years[state.k + 1]);
  }, 100);
}

function stop() {
  if (!state.playing) return;
  state.playing.stop();
  state.playing = null;
  document.getElementById("play").textContent = "▶";
}

// The years averaged for the selected year: the selected year and the ones before it.
function windowRange() {
  return [Math.max(0, state.k - state.win + 1), state.k];
}

// Average each cell over years k0..k1 (skipping land). Only recomputed when the window changes.
function updateFrame(k0, k1) {
  const key = `${k0}|${k1}`;
  if (key === frameKey) return;
  frameKey = key;

  const cell = nx * ny, sum = new Float32Array(cell), cnt = new Uint8Array(cell);
  for (let t = k0; t <= k1; t++) {
    for (let c = 0; c < cell; c++) {
      const q = data[t * cell + c];
      if (q === meta.fill) continue;                     // land
      sum[c] += q;
      cnt[c]++;
    }
  }
  frame = sum.map((s, c) => (cnt[c] ? s / cnt[c] / meta.scale : NaN));   // °C
}

// ---------- zoom and pan ----------
function setupZoom() {
  zoom = d3.zoom()
    .scaleExtent([1, 16])
    // The page scrolls, so only zoom with the wheel when ⌘/Ctrl is held (or on a trackpad pinch).
    .filter((event) => (event.type === "wheel" ? event.ctrlKey || event.metaKey : !event.button))
    .on("zoom", (event) => { state.t = event.transform; render(); });

  const canvas = d3.select("#map");
  canvas.call(zoom);

  d3.select("#zoom-in").on("click", () => canvas.transition().duration(250).call(zoom.scaleBy, 1.8));
  d3.select("#zoom-out").on("click", () => canvas.transition().duration(250).call(zoom.scaleBy, 1 / 1.8));
  d3.select("#zoom-reset").on("click", () => canvas.transition().duration(400).call(zoom.transform, d3.zoomIdentity));
}

// ---------- layout ----------
const lonX = () => d3.scaleLinear([0, 360], [0, mapW]);
const latY = () => d3.scaleLinear([-90, 90], [mapH, 0]);

function layout() {
  const wrap = document.getElementById("map-wrap");
  const parent = wrap.parentElement, cs = getComputedStyle(parent);
  const contentW = parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availW = contentW - M.left;
  // as wide as the page allows, but no taller than a fraction of the window (the map is 2:1)
  mapW = Math.round(Math.max(480, Math.min(availW, 2 * window.innerHeight * MAP_HEIGHT_FRACTION)));
  mapH = Math.round(mapW / 2);

  // centre the map, timeline and legend as one column
  const pad = Math.max(0, (contentW - (mapW + M.left)) / 2);
  wrap.style.width = mapW + M.left + "px";
  wrap.style.marginLeft = pad + "px";
  document.getElementById("timeline").style.marginLeft = pad + M.left + "px";
  document.querySelector(".legend").style.marginLeft = pad + M.left + "px";

  const dpr = window.devicePixelRatio || 1;
  const canvas = ctx.canvas;
  canvas.style.width = mapW + "px";
  canvas.style.height = mapH + "px";
  canvas.width = Math.round(mapW * dpr);
  canvas.height = Math.round(mapH * dpr);
  wrap.style.height = mapH + M.bottom + "px";

  buildColors();
  buildTimeline();

  // keep panning inside the map, and start from the full view after a resize
  zoom.extent([[0, 0], [mapW, mapH]]).translateExtent([[0, 0], [mapW, mapH]]);
  state.t = d3.zoomIdentity;
  d3.select("#map").call(zoom.transform, d3.zoomIdentity);
}


// Axes use the zoomed scales, so the labels stay correct while zooming.
function drawAxes() {
  const x = state.t.rescaleX(lonX()), y = state.t.rescaleY(latY());
  const svg = d3.select("#map-axes");
  svg.selectAll("*").remove();
  const g = svg.append("g").attr("transform", `translate(${M.left},0)`);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${mapH})`)
    .call(d3.axisBottom(x).ticks(mapW < 700 ? 5 : 9).tickFormat((d) => d + "°E").tickSizeOuter(0));
  g.append("g").attr("class", "axis")
    .call(d3.axisLeft(y).ticks(9)
      .tickFormat((d) => (d === 0 ? "0°" : Math.abs(d) + (d < 0 ? "°S" : "°N"))).tickSizeOuter(0));
}

// Pre-compute one color per possible data value (-2.00 … +2.00 °C in 0.01 steps)
// so drawing 65,000 cells doesn't re-run the color scale every time.
function buildColors() {
  const scale = d3.scaleLinear()
    .domain([-LIMIT, -LIMIT / 2, 0, LIMIT / 2, LIMIT])
    .range(["--div-neg-2", "--div-neg-1", "--div-mid", "--div-pos-1", "--div-pos-2"].map(css))
    .interpolate(d3.interpolateLab)
    .clamp(true);
  colors = d3.range(-LIMIT * 100, LIMIT * 100 + 1).map((q) => scale(q / 100));
  colors.scale = scale;
  colors.rgb = colors.map((c) => d3.rgb(c));
}

// ---------- draw the map ----------
function render() {
  if (!mapW || !colors) return;
  const k = state.k;
  const [k0, k1] = windowRange(), y0 = meta.years[k0], y1 = meta.years[k1];
  updateFrame(k0, k1);

  drawTemperature();
  drawAxes();

  // text above the map
  const span = state.win > 1 ? `${y0}–${y1}` : `${y1}`;
  document.getElementById("year-label").textContent = meta.years[k];
  document.getElementById("subtitle").textContent =
    `Ocean surface temperature ${state.win > 1 ? `averaged over ${span}` : `in ${span}`}, ` +
    `compared with ${meta.baseline[0]}–${meta.baseline[1]} · ` +
    `whole-ocean change: ${fmt(d3.mean(meta.global_mean.slice(k0, k1 + 1)))} °C`;

  renderLegend();
  updateMarker();
}

// Paint one pixel per cell on a tiny canvas, then let the browser stretch it with blended
// (bilinear) colors. Land pixels stay transparent, so the gray shows through.
function drawTemperature() {
  const t = state.t, dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);     // the zoom transform moves everything
  ctx.fillStyle = css("--land");
  ctx.fillRect(0, 0, mapW, mapH);

  const img = offCtx.createImageData(nx, ny);
  for (let j = 0; j < ny; j++) {
    const r = ny - 1 - j;                                // data row j = 0 is the south; the image's top row is the north
    for (let i = 0; i < nx; i++) {
      const v = frame[j * nx + i];
      if (Number.isNaN(v)) continue;                     // land
      const q = Math.max(-LIMIT * 100, Math.min(LIMIT * 100, Math.round(v * 100)));
      const c = colors.rgb[q + LIMIT * 100];
      const p = (r * nx + i) * 4;
      img.data[p] = c.r; img.data[p + 1] = c.g; img.data[p + 2] = c.b; img.data[p + 3] = 255;
    }
  }
  offCtx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(off, 0, 0, mapW, mapH);
}

function renderLegend() {
  const svg = d3.select("#legend");
  const w = svg.node().clientWidth, barH = 12;
  svg.selectAll("*").remove();

  const grad = svg.append("defs").append("linearGradient").attr("id", "legend-grad");
  d3.range(0, 1.0001, 0.1).forEach((t) =>
    grad.append("stop").attr("offset", t).attr("stop-color", colors.scale(-LIMIT + 2 * LIMIT * t)));
  svg.append("rect").attr("width", w).attr("height", barH).attr("rx", 3).attr("fill", "url(#legend-grad)");

  const x = d3.scaleLinear([-LIMIT, LIMIT], [0, w]);
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${barH})`)
    .call(d3.axisBottom(x).tickValues([-2, -1, 0, 1, 2]).tickFormat(d3.format("+d")).tickSize(3).tickSizeOuter(0))
    .call((a) => a.select(".domain").remove());
  svg.append("text").attr("x", w / 2).attr("y", barH + 30).attr("text-anchor", "middle")
    .text("Change vs. 1850–1900 (°C)");
}

// ---------- timeline: global mean through time (click or drag to pick a year) ----------
function buildTimeline() {
  const h = 74, margin = { top: 6, bottom: 18 };
  const svg = d3.select("#timeline").attr("width", mapW).attr("height", h);
  svg.selectAll("*").remove();

  tlX = d3.scaleLinear(d3.extent(meta.years), [0, mapW]);
  tlY = d3.scaleLinear([Math.min(0, d3.min(meta.global_mean)), d3.max(meta.global_mean)], [h - margin.bottom, margin.top]).nice();

  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h - margin.bottom})`)
    .call(d3.axisBottom(tlX).ticks(mapW < 700 ? 6 : 16).tickFormat(d3.format("d")).tickSizeOuter(0));
  svg.append("g").attr("class", "axis")
    .call(d3.axisLeft(tlY).ticks(3).tickFormat(d3.format("+.1f")).tickSizeOuter(0));
  svg.append("text").attr("x", 8).attr("y", margin.top + 8)      // upper-left, where the line is low
    .text("global ocean mean anomaly (°C)");

  // shaded band = the years being averaged
  svg.append("rect").attr("id", "tl-window").attr("y", margin.top).attr("height", h - margin.bottom - margin.top)
    .attr("fill", css("--accent")).attr("opacity", 0.15);

  const line = d3.line().x((d, i) => tlX(meta.years[i])).y((d) => tlY(d));
  svg.append("path").datum(meta.global_mean)
    .attr("fill", "none").attr("stroke", css("--accent")).attr("stroke-width", 2).attr("d", line);

  svg.append("line").attr("id", "tl-marker")
    .attr("y1", margin.top).attr("y2", h - margin.bottom)
    .attr("stroke", css("--text-primary")).attr("stroke-width", 1.5);

  // invisible rectangle on top catches clicks and drags
  svg.append("rect").attr("width", mapW).attr("height", h).attr("fill", "transparent")
    .on("pointerdown pointermove", (event) => {
      if (event.type === "pointermove" && event.buttons !== 1) return;   // only while dragging
      stop();
      setYear(Math.round(tlX.invert(d3.pointer(event)[0])));
    });
}

function updateMarker() {
  if (!tlX) return;
  const [k0, k1] = windowRange();
  const x0 = tlX(meta.years[k0]), x1 = tlX(meta.years[k1]);
  d3.select("#tl-marker").attr("x1", x1).attr("x2", x1);
  d3.select("#tl-window").attr("x", x0).attr("width", Math.max(2, x1 - x0));
}

// ---------- tooltip (undoes the zoom transform to find the cell under the mouse) ----------
function setupHover() {
  const canvas = ctx.canvas, tip = document.getElementById("tooltip");

  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const [mx, my] = state.t.invert([px, py]);          // position on the un-zoomed map
    const i = Math.floor((mx / mapW) * nx);
    const j = Math.floor(((mapH - my) / mapH) * ny);
    if (i < 0 || i >= nx || j < 0 || j >= ny) { tip.hidden = true; return; }

    const [k0, k1] = windowRange();
    const when = state.win > 1 ? `${meta.years[k0]}–${meta.years[k1]} average` : meta.years[k1];
    const v = frame[j * nx + i];
    const lon = meta.lon[i], lat = meta.lat[j];
    const lonTxt = lon > 180 ? (360 - lon).toFixed(1) + "°W" : lon.toFixed(1) + "°E";
    const latTxt = Math.abs(lat).toFixed(1) + (lat < 0 ? "°S" : "°N");

    tip.innerHTML = `<span class="muted">${lonTxt}, ${latTxt}</span><br>` +
      (Number.isNaN(v) ? "land / no data" : `${when}: <strong>${fmt(v)}</strong> °C vs. 1850–1900`);
    tip.hidden = false;

    const wrapW = canvas.parentElement.clientWidth;
    tip.style.left = Math.min(px + M.left + 14, wrapW - tip.offsetWidth - 4) + "px";
    tip.style.top = Math.max(0, py - 44) + "px";
  });

  canvas.addEventListener("pointerleave", () => { tip.hidden = true; });
}
