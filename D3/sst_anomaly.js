// Ocean surface warming map (SST anomaly vs 1850–1900) and Arctic sea-ice map (September),
// with zoom, pan, region shortcuts and an averaging window.
// Data comes from export_sst_anomaly.py and export_arctic_ice.py.

const LIMIT = 2;                          // °C: fixed color range for every year (temperature view)
const M = { left: 34, bottom: 22 };       // room for axis labels around the map
const MAP_HEIGHT_FRACTION = 0.75;         // the map takes about this much of the window height
const state = { k: 0, win: 10, playing: null, t: d3.zoomIdentity, view: "temp" };   // k = year index, win = years averaged, t = zoom transform

let meta, data, nx, ny;                   // temperature data
let iceMeta, iceData, iceN, latMin, landGeo;  // sea-ice picture + coastlines (both optional)
let ctx, mapW, mapH, colors, tlX, tlY, zoom, off, offCtx, polar, polarCtx, polarImg, polarLand;
let frame, iceFrame, frameKey = "";       // the averaged values currently on screen

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = d3.format("+.2f");

// Places to jump to in the temperature view: centre (lon in 0–360°E, lat) and zoom level k.
const REGIONS = [
  { name: "World",            lon: 180, lat: 0,   k: 1 },
  { name: "Arctic",           lon: 40,  lat: 75,  k: 3 },
  { name: "North Atlantic",   lon: 320, lat: 40,  k: 3 },
  { name: "North Pacific",    lon: 190, lat: 40,  k: 3 },
  { name: "Tropical Pacific", lon: 200, lat: 0,   k: 2.5 },
  { name: "Indian Ocean",     lon: 75,  lat: -10, k: 3 },
  { name: "Southern Ocean",   lon: 180, lat: -60, k: 2.5 },
];

// The ice files are optional: if they don't exist yet, the sea-ice button is disabled.
function loadIce() {
  return Promise.all([
    fetch("data/arctic_ice_meta.json").then((r) => { if (!r.ok) throw new Error("no ice meta"); return r.json(); }),
    fetch("data/arctic_ice.bin").then((r) => { if (!r.ok) throw new Error("no ice data"); return r.arrayBuffer(); }),
  ]).then(([m, buf]) => ({ meta: m, data: new Uint8Array(buf) })).catch(() => null);
}

// Coastlines (optional). Keep only the polygons that reach into the northern hemisphere.
function loadLand() {
  return fetch("data/land-50m.json")
    .then((r) => { if (!r.ok) throw new Error("no land file"); return r.json(); })
    .then((topo) => {
      const f = topojson.feature(topo, topo.objects.land);
      const geoms = f.type === "FeatureCollection" ? f.features.map((x) => x.geometry) : [f.geometry];
      const polys = [];
      geoms.forEach((g) => (g.type === "MultiPolygon" ? g.coordinates : [g.coordinates]).forEach((c) => polys.push(c)));
      return { type: "MultiPolygon", coordinates: polys.filter((c) => c[0].some((pt) => pt[1] > 30)) };
    })
    .catch(() => null);
}

Promise.all([
  fetch("data/sst_anom_meta.json").then((r) => r.json()),
  fetch("data/sst_anom.bin").then((r) => r.arrayBuffer()),
  loadIce(),
  loadLand(),
]).then(([m, buf, ice, land]) => {
  meta = m;
  data = new Int16Array(buf);
  nx = meta.lon.length;
  ny = meta.lat.length;
  if (ice && ice.meta.n && ice.meta.years.length === meta.years.length) {   // ignore files from the old export
    iceMeta = ice.meta; iceData = ice.data; iceN = iceMeta.n; latMin = iceMeta.lat_min;
  }
  landGeo = land;
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

  document.querySelectorAll('input[name="view"]').forEach((r) =>
    r.addEventListener("change", () => setView(r.value)));
  document.querySelectorAll('input[name="win"]').forEach((r) =>
    r.addEventListener("change", () => { state.win = +r.value; render(); }));
  state.win = +document.querySelector('input[name="win"]:checked').value;
  if (!iceMeta) {
    const r = document.getElementById("view-ice");
    r.disabled = true;
    r.parentElement.title = "Run export_arctic_ice.py to enable this view";
  }

  ctx = document.getElementById("map").getContext("2d");
  off = document.createElement("canvas");               // temperature: one pixel per grid cell
  off.width = nx; off.height = ny;
  offCtx = off.getContext("2d");
  polar = document.createElement("canvas");             // sea ice: the polar picture, one pixel per value
  polarCtx = polar.getContext("2d");
  if (iceMeta) {
    polar.width = iceN; polar.height = iceN;
    polarImg = polarCtx.createImageData(iceN, iceN);
  }

  setupZoom();
  setupHover();

  const refresh = () => { layout(); render(); };
  new ResizeObserver(refresh).observe(document.getElementById("map-wrap"));
  window.addEventListener("resize", refresh);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refresh);
}

// ---------- view switch ----------
function setView(v) {
  state.view = v;
  d3.select("#regions").style("display", v === "ice" ? "none" : null);   // region shortcuts are for the flat map
  buildTimeline();
  d3.select("#map").call(zoom.transform, d3.zoomIdentity);               // reset zoom (this also redraws)
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
  const key = `${state.view}|${k0}|${k1}`;
  if (key === frameKey) return;
  frameKey = key;

  if (state.view === "ice") {
    const cell = iceN * iceN, sum = new Float32Array(cell), cnt = new Uint8Array(cell);
    for (let t = k0; t <= k1; t++) {
      for (let c = 0; c < cell; c++) {
        const v = iceData[t * cell + c];
        if (v === iceMeta.fill) continue;
        sum[c] += v & 127;                               // the low 7 bits hold the ice %, bit 128 flags land
        cnt[c]++;
      }
    }
    iceFrame = sum.map((s, c) => (cnt[c] ? s / cnt[c] : 0));
  } else {
    const cell = nx * ny, sum = new Float32Array(cell), cnt = new Uint8Array(cell);
    for (let t = k0; t <= k1; t++) {
      for (let c = 0; c < cell; c++) {
        const q = data[t * cell + c];
        if (q === meta.fill) continue;                   // land
        sum[c] += q;
        cnt[c]++;
      }
    }
    frame = sum.map((s, c) => (cnt[c] ? s / cnt[c] / meta.scale : NaN));   // °C
  }
}

// ---------- zoom, pan and region shortcuts ----------
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

  d3.select("#regions").selectAll("button")
    .data(REGIONS)
    .join("button")
    .attr("type", "button")
    .text((d) => d.name)
    .on("click", (event, d) => goTo(d));
}

// Smoothly zoom to a region: put its centre in the middle of the map at zoom level k.
function goTo(region) {
  const k = region.k;
  const cx = lonX()(region.lon), cy = latY()(region.lat);       // centre in un-zoomed map pixels
  // keep the view inside the map (the same limit as the pan limit)
  const tx = Math.max(mapW - k * mapW, Math.min(0, mapW / 2 - k * cx));
  const ty = Math.max(mapH - k * mapH, Math.min(0, mapH / 2 - k * cy));
  d3.select("#map").transition().duration(700)
    .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
}

// ---------- layout ----------
const lonX = () => d3.scaleLinear([0, 360], [0, mapW]);
const latY = () => d3.scaleLinear([-90, 90], [mapH, 0]);

function layout() {
  const wrap = document.getElementById("map-wrap");
  const availW = wrap.parentElement.clientWidth - M.left;
  // as wide as the page allows, but no taller than a fraction of the window (the map is 2:1)
  mapW = Math.round(Math.max(480, Math.min(availW, 2 * window.innerHeight * MAP_HEIGHT_FRACTION)));
  mapH = Math.round(mapW / 2);

  const dpr = window.devicePixelRatio || 1;
  const canvas = ctx.canvas;
  canvas.style.width = mapW + "px";
  canvas.style.height = mapH + "px";
  canvas.width = Math.round(mapW * dpr);
  canvas.height = Math.round(mapH * dpr);
  wrap.style.height = mapH + M.bottom + "px";

  buildColors();
  buildPolarLand();
  buildTimeline();

  // keep panning inside the map, and start from the full view after a resize
  zoom.extent([[0, 0], [mapW, mapH]]).translateExtent([[0, 0], [mapW, mapH]]);
  state.t = d3.zoomIdentity;
  d3.select("#map").call(zoom.transform, d3.zoomIdentity);
}

// Axes of the flat temperature map; they use the zoomed scales so labels stay correct while zooming.
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

// Pre-compute colors so drawing 65,000 cells doesn't re-run a color scale for each one.
function buildColors() {
  const scale = d3.scaleLinear()
    .domain([-LIMIT, -LIMIT / 2, 0, LIMIT / 2, LIMIT])
    .range(["--div-neg-2", "--div-neg-1", "--div-mid", "--div-pos-1", "--div-pos-2"].map(css))
    .interpolate(d3.interpolateLab)
    .clamp(true);
  colors = d3.range(-LIMIT * 100, LIMIT * 100 + 1).map((q) => scale(q / 100));   // one per 0.01 °C
  colors.scale = scale;
  colors.rgb = colors.map((c) => d3.rgb(c));

  const iceScale = d3.scaleLinear().domain([0, 100])
    .range([css("--ice-open"), css("--ice-full")]).interpolate(d3.interpolateLab);
  colors.iceScale = iceScale;
  colors.iceRgb = d3.range(101).map((v) => d3.rgb(iceScale(v)));                 // one per 1 %
  colors.landRgb = d3.rgb(css("--land"));
}

// ---------- draw the map ----------
function render() {
  if (!mapW || !colors) return;
  const k = state.k, ice = state.view === "ice";
  const [k0, k1] = windowRange(), y0 = meta.years[k0], y1 = meta.years[k1];
  updateFrame(k0, k1);

  if (ice) { drawPolar(); drawPolarAxes(); }
  else { drawTemperature(); drawAxes(); }

  const when = state.win > 1 ? `${y0}–${y1} average` : `${y1}`;
  document.getElementById("year-label").textContent = meta.years[k];
  document.getElementById("subtitle").textContent = ice
    ? `Arctic sea-ice concentration in September, ${when} · estimated ice area ${d3.mean(iceMeta.area.slice(k0, k1 + 1)).toFixed(1)} million km²`
    : `Sea-surface temperature, ${when}, vs. the ${meta.baseline[0]}–${meta.baseline[1]} average · ` +
      `global ocean mean ${fmt(d3.mean(meta.global_mean.slice(k0, k1 + 1)))} °C`;

  renderLegend();
  updateMarker();
}

// Temperature: paint one pixel per cell on a tiny canvas, then let the browser stretch it
// with blended (bilinear) colors. Land pixels stay transparent, so the gray shows through.
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

// ---------- polar sea-ice map ----------
// The pole is at the centre; latitude latMin is the rim; longitude 0° points down, 90°E to the right.
const polarR = () => mapH / 2 - 20;                       // rim radius in pixels (leaves room for labels)

// Un-zoomed map position → latitude/longitude, or null outside the disc.
function polarLatLon(ux, uy) {
  const R = polarR(), dx = ux - mapW / 2, dy = uy - mapH / 2, r = Math.hypot(dx, dy);
  if (r > R) return null;
  return { lat: 90 - (r / R) * (90 - latMin), lon: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 };
}

// Coastlines drawn in the same polar layout, as one path we can fill quickly on every frame.
function buildPolarLand() {
  polarLand = null;
  if (!landGeo || !iceMeta) return;
  const R = polarR(), span = ((90 - latMin) * Math.PI) / 180;
  const proj = d3.geoProjection((lam, phi) => {           // colatitude → distance from the centre
    const r = Math.PI / 2 - phi;
    return [r * Math.sin(lam), -r * Math.cos(lam)];       // (d3 flips y, so this puts longitude 0° at the bottom)
  }).scale(R / span).translate([mapW / 2, mapH / 2]);
  polarLand = new Path2D(d3.geoPath(proj)(landGeo));
}

function drawPolar() {
  const t = state.t, dpr = window.devicePixelRatio || 1, R = polarR(), cx = mapW / 2, cy = mapH / 2;
  const base = state.k * iceN * iceN, px = polarImg.data;
  const rgb = colors.iceRgb, land = colors.landRgb, hasCoast = !!polarLand;

  // 1) turn the numbers into colors, one pixel per value
  for (let i = 0; i < iceN * iceN; i++) {
    const v = iceData[base + i], p = i * 4;
    if (v === iceMeta.fill) { px[p + 3] = 0; continue; }              // outside the disc
    const c = v >= 128 && !hasCoast ? land : rgb[Math.round(iceFrame[i])];   // land pixels are covered by the coastline layer
    px[p] = c.r; px[p + 1] = c.g; px[p + 2] = c.b; px[p + 3] = 255;
  }
  polarCtx.putImageData(polarImg, 0, 0);

  // 2) stretch the picture over the disc (the browser blends neighbouring pixels), then add the coastlines
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, mapW, mapH);
  ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);  // the zoom transform moves everything
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.clip();                                                         // keep everything inside the disc
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(polar, cx - R, cy - R, 2 * R, 2 * R);
  if (hasCoast) {
    ctx.fillStyle = css("--land");
    ctx.fill(polarLand);
    ctx.strokeStyle = css("--surface-1");
    ctx.lineWidth = 0.7 / t.k;
    ctx.stroke(polarLand);
  }
  ctx.restore();
}

// Latitude rings and longitude spokes, drawn in SVG over the polar map (they follow the zoom).
function drawPolarAxes() {
  const t = state.t, R = polarR(), span = 90 - latMin;
  const svg = d3.select("#map-axes");
  svg.selectAll("*").remove();
  svg.append("defs").append("clipPath").attr("id", "clip-map")
    .append("rect").attr("width", mapW).attr("height", mapH);
  const g = svg.append("g").attr("transform", `translate(${M.left},0)`).attr("clip-path", "url(#clip-map)");

  const [cx, cy] = t.apply([mapW / 2, mapH / 2]);
  const dir = (lon) => [Math.sin((lon * Math.PI) / 180), Math.cos((lon * Math.PI) / 180)];
  const radius = (lat) => ((90 - lat) / span) * R * t.k;

  [[0, "0°"], [90, "90°E"], [180, "180°"], [270, "90°W"]].forEach(([lon, label]) => {
    const [ux, uy] = dir(lon), r = radius(latMin);
    g.append("line").attr("class", "polar-line").attr("x1", cx).attr("y1", cy)
      .attr("x2", cx + ux * r).attr("y2", cy + uy * r);
    g.append("text").attr("class", "polar-label").attr("text-anchor", "middle")
      .attr("x", cx + ux * (r + 12)).attr("y", cy + uy * (r + 12) + 4).text(label);
  });

  [latMin, 60, 70, 80].forEach((lat) => {
    g.append("circle").attr("class", "polar-line").attr("cx", cx).attr("cy", cy).attr("r", radius(lat));
    if (lat > latMin) {
      const [ux, uy] = dir(45);
      g.append("text").attr("class", "polar-label")
        .attr("x", cx + ux * radius(lat) + 3).attr("y", cy + uy * radius(lat) + 12).text(lat + "°N");
    }
  });
}

// ---------- legend ----------
function renderLegend() {
  const ice = state.view === "ice";
  const domain = ice ? [0, 100] : [-LIMIT, LIMIT];
  const scale = ice ? colors.iceScale : colors.scale;
  const ticks = ice ? [0, 25, 50, 75, 100] : [-2, -1, 0, 1, 2];
  const tickFmt = ice ? (d) => d + "%" : d3.format("+d");
  const label = ice ? "Share of the ocean covered by sea ice" : "Change vs. 1850–1900 (°C)";

  const svg = d3.select("#legend");
  const w = svg.node().clientWidth, barH = 12;
  svg.selectAll("*").remove();

  const grad = svg.append("defs").append("linearGradient").attr("id", "legend-grad");
  d3.range(0, 1.0001, 0.1).forEach((t) =>
    grad.append("stop").attr("offset", t).attr("stop-color", scale(domain[0] + (domain[1] - domain[0]) * t)));
  svg.append("rect").attr("width", w).attr("height", barH).attr("rx", 3).attr("fill", "url(#legend-grad)");

  const x = d3.scaleLinear(domain, [0, w]);
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${barH})`)
    .call(d3.axisBottom(x).tickValues(ticks).tickFormat(tickFmt).tickSize(3).tickSizeOuter(0))
    .call((a) => a.select(".domain").remove());
  svg.append("text").attr("x", w / 2).attr("y", barH + 30).attr("text-anchor", "middle").text(label);
}

// ---------- timeline (click or drag to pick a year) ----------
// Temperature view: global ocean mean anomaly. Sea-ice view: September Arctic ice area.
function currentSeries() {
  return state.view === "ice"
    ? { values: iceMeta.area, label: "Arctic September sea-ice area (million km²)", fmt: d3.format(".0f"), fromZero: true, labelRight: true }
    : { values: meta.global_mean, label: "global ocean mean anomaly (°C)", fmt: d3.format("+.1f"), fromZero: false, labelRight: false };
}

function buildTimeline() {
  const h = 74, margin = { top: 6, bottom: 18 };
  const s = currentSeries();
  const svg = d3.select("#timeline").attr("width", mapW).attr("height", h);
  svg.selectAll("*").remove();

  tlX = d3.scaleLinear(d3.extent(meta.years), [0, mapW]);
  const lo = s.fromZero ? 0 : Math.min(0, d3.min(s.values));
  tlY = d3.scaleLinear([lo, d3.max(s.values)], [h - margin.bottom, margin.top]).nice();

  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h - margin.bottom})`)
    .call(d3.axisBottom(tlX).ticks(mapW < 700 ? 6 : 16).tickFormat(d3.format("d")).tickSizeOuter(0));
  svg.append("g").attr("class", "axis")
    .call(d3.axisLeft(tlY).ticks(3).tickFormat(s.fmt).tickSizeOuter(0));
  svg.append("text").attr("x", s.labelRight ? mapW - 8 : 8).attr("y", margin.top + 8)   // where the line is low
    .attr("text-anchor", s.labelRight ? "end" : "start").text(s.label);

  // shaded band = the years being averaged
  svg.append("rect").attr("id", "tl-window").attr("y", margin.top).attr("height", h - margin.bottom - margin.top)
    .attr("fill", css("--accent")).attr("opacity", 0.15);

  const line = d3.line().x((d, i) => tlX(meta.years[i])).y((d) => tlY(d));
  svg.append("path").datum(s.values)
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
    const [k0, k1] = windowRange();
    const when = state.win > 1 ? `${meta.years[k0]}–${meta.years[k1]} average` : meta.years[k1];
    let html;

    if (state.view === "ice") {
      const p = polarLatLon(mx, my);
      if (!p) { tip.hidden = true; return; }
      const R = polarR();
      const ix = Math.min(iceN - 1, Math.floor(((mx - mapW / 2) / R + 1) / 2 * iceN));
      const iy = Math.min(iceN - 1, Math.floor(((my - mapH / 2) / R + 1) / 2 * iceN));
      const v = iceData[state.k * iceN * iceN + iy * iceN + ix];
      if (v === iceMeta.fill) { tip.hidden = true; return; }
      const lonTxt = p.lon > 180 ? (360 - p.lon).toFixed(0) + "°W" : p.lon.toFixed(0) + "°E";
      html = `<span class="muted">${lonTxt}, ${p.lat.toFixed(1)}°N</span><br>` +
        (v >= 128 ? "land" : `September ${when}: <strong>${Math.round(iceFrame[iy * iceN + ix])}%</strong> ice cover`);
    } else {
      const i = Math.floor((mx / mapW) * nx), j = Math.floor(((mapH - my) / mapH) * ny);
      if (i < 0 || i >= nx || j < 0 || j >= ny) { tip.hidden = true; return; }
      const v = frame[j * nx + i];
      const lon = meta.lon[i], lat = meta.lat[j];
      const lonTxt = lon > 180 ? (360 - lon).toFixed(1) + "°W" : lon.toFixed(1) + "°E";
      const latTxt = Math.abs(lat).toFixed(1) + (lat < 0 ? "°S" : "°N");
      html = `<span class="muted">${lonTxt}, ${latTxt}</span><br>` +
        (Number.isNaN(v) ? "land / no data"
          : `${when}: <strong>${fmt(v)}</strong> °C vs. 1850–1900`);
    }

    tip.innerHTML = html;
    tip.hidden = false;
    const wrapW = canvas.parentElement.clientWidth;
    tip.style.left = Math.min(px + M.left + 14, wrapW - tip.offsetWidth - 4) + "px";
    tip.style.top = Math.max(0, py - 44) + "px";
  });

  canvas.addEventListener("pointerleave", () => { tip.hidden = true; });
}
