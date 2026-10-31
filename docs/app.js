/* Label vs. Reality · Berlin — #30DayMapChallenge 2026, Day 1 (Points)
 *
 * data/addresses.json      columnar address points: lon/lat × 1e5, c = 0 einfach / 1 mittel / 2 gut, r = rent of the 100 m cell
 * data/cells.geojson       Zensus 100 m cells: r rent, L dominant label level 1–3, R rent level 1–3, s score, u value in brackets, id Gitter-ID
 * data/buildings.pmtiles   LoD2 buildings (layer "b"): h height, l label 0–2 (−1 none), r rent, R rent level, s score, n addresses
 * Score = rent level (Berlin-wide third of rent) − label level (simple 1, medium 2, good 3), from −2 to +2.
 */
(async function () {
  const $ = (s) => document.querySelector(s);
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const fmt = (n) => n.toLocaleString("en");

  // ------------------------------------------------ colours
  const LABELS = [
    { key: "einfach", en: "simple", c: "#a9bfd0" },
    { key: "mittel", en: "medium", c: "#5f82ab" },
    { key: "gut", en: "good", c: "#24365f" },
  ];
  const SCORE = {
    "-2": { c: "#b4316f", t: "Much cheaper than the label", s: "Good label, block in Berlin's cheapest third." },
    "-1": { c: "#e59bbf", t: "Cheaper than the label", s: "Rent one level below what the label suggests." },
    "0": { c: dark ? "#6a655c" : "#d4cdbf", t: "As the label suggests", s: "Label and rent level match." },
    "1": { c: "#86cccc", t: "Pricier than the label", s: "Rent one level above what the label suggests." },
    "2": { c: "#1d8585", t: "Much pricier than the label", s: "Simple label, block in Berlin's most expensive third." },
  };
  const RENT = [[5.5, "#fbf1cf"], [6.5, "#f4d27e"], [7.5, "#ee9d52"], [8.5, "#d95c40"], [10, "#9d2c47"], [12, "#561b3c"]];
  const GREY = dark ? "#4a4741" : "#e6e0d5";
  const LEVEL_R = ["", "cheapest third", "middle third", "most expensive third"];

  // ------------------------------------------------ data
  const pm = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", pm.tile);
  const head = (u) => fetch(u, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
  const [A, STATS, hasB, hasBcsv, DIAG] = await Promise.all([
    fetch("data/addresses.json").then((r) => r.json()),
    fetch("data/stats.json").then((r) => r.json()),
    head("data/buildings.pmtiles"),
    head("data/scores_buildings.csv.zip"),
    fetch("data/diagnostics.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]);
  const B = STATS.berlin, [q1, q2] = B.terciles, N = A.lon.length;
  const levelR = (r) => (r == null ? null : r < q1 ? 1 : r < q2 ? 2 : 3);

  const feats = new Array(N);
  for (let i = 0; i < N; i++) {
    const L = A.c[i] + 1, R = levelR(A.r[i]);
    const p = { L };
    if (R) { p.R = R; p.s = R - L; p.r = A.r[i]; }
    feats[i] = { type: "Feature", id: i, properties: p, geometry: { type: "Point", coordinates: [A.lon[i] / 1e5, A.lat[i] / 1e5] } };
  }

  // ------------------------------------------------ map
  const map = new maplibregl.Map({
    container: "map",
    style: `https://basemaps.cartocdn.com/gl/${dark ? "dark-matter" : "positron"}-gl-style/style.json`,
    center: [13.40, 52.505], zoom: innerWidth <= 860 ? 9.6 : 10.4, minZoom: 9, maxZoom: 19, maxPitch: 70,
    attributionControl: { compact: innerWidth <= 860,
      customAttribution: "Wohnlagen 2026 & LoD2 © Geoportal Berlin (dl-de/zero-2-0) · Zensus 2022 © Statistische Ämter des Bundes und der Länder" },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

  let mode = "score", view = "points", sel = null, opac = 0.85;

  const scoreExpr = (key = "s") => ["match", ["get", key], -2, SCORE["-2"].c, -1, SCORE["-1"].c, 0, SCORE["0"].c, 1, SCORE["1"].c, 2, SCORE["2"].c, GREY];
  const rentExpr = ["interpolate", ["linear"], ["get", "r"], ...RENT.flat()];
  const labelExpr = (key, off) => ["match", ["get", key], 0 + off, LABELS[0].c, 1 + off, LABELS[1].c, 2 + off, LABELS[2].c, GREY];

  map.on("load", () => {
    map.addSource("cells", { type: "geojson", data: "data/cells.geojson" });
    map.addSource("addr", { type: "geojson", data: { type: "FeatureCollection", features: feats }, buffer: 0, tolerance: 0, maxzoom: 14 });
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;

    map.addLayer({ id: "cells", type: "fill", source: "cells", paint: { "fill-color": scoreExpr(), "fill-opacity": 0.8 } }, firstSymbol);
    map.addLayer({ id: "dots", type: "circle", source: "addr", paint: {
      "circle-color": scoreExpr(),
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 11, 1.3, 13, 2.2, 15, 3.6, 17, 6, 19, 9],
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 14, 0, 16, 0.8],
      "circle-stroke-color": dark ? "#161513" : "#fdfbf7" } });
    if (hasB) {
      map.addSource("bld", { type: "vector", url: "pmtiles://" + new URL("data/buildings.pmtiles", location.href).href });
      map.addLayer({ id: "bld", type: "fill-extrusion", source: "bld", "source-layer": "b", minzoom: 12,
        layout: { visibility: "none" },
        paint: { "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 0.92, "fill-extrusion-vertical-gradient": true } });
    } else {
      $("#v3d").disabled = true;
      $("#v3d").title = "3D buildings are created by the GitHub Action (LoD2)";
    }
    map.addLayer({ id: "hl", type: "circle", source: "addr", filter: ["==", ["id"], -1],
      paint: { "circle-radius": 10, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 3, "circle-stroke-color": dark ? "#fff" : "#2b2925" } });

    const done = () => { if (map.isSourceLoaded("addr")) { $("#loading").classList.add("done"); map.off("sourcedata", done); } };
    map.on("sourcedata", done);
    render();
  });

  // ------------------------------------------------ render state → map
  function filters() {
    if (!sel) return { cells: null, dots: null, bld: null };
    const { L, R } = sel;
    return {
      cells: ["all", ["==", ["get", "L"], L], ["==", ["get", "R"], R]],
      dots: ["all", ["==", ["get", "L"], L], ["==", ["get", "R"], R]],
      bld: ["all", ["==", ["get", "l"], L - 1], ["==", ["get", "R"], R]],
    };
  }
  function render() {
    if (!map.getLayer("cells")) return;
    const f = filters();
    map.setPaintProperty("cells", "fill-color", mode === "rent" ? rentExpr : mode === "label" ? labelExpr("L", 1) : scoreExpr());
    map.setLayoutProperty("cells", "visibility", view === "points" ? "none" : "visible");
    map.setPaintProperty("cells", "fill-opacity", view === "3d" ? opac * 0.3 : mode === "label" ? opac * 0.9 : opac);
    map.setFilter("cells", f.cells);
    map.setLayoutProperty("dots", "visibility", view === "points" ? "visible" : "none");
    map.setPaintProperty("dots", "circle-color", mode === "label" ? labelExpr("L", 1)
      : mode === "rent" ? ["case", ["has", "r"], rentExpr, GREY] : scoreExpr());
    map.setPaintProperty("dots", "circle-opacity", Math.min(1, opac + 0.1));
    map.setFilter("dots", f.dots);
    if (map.getLayer("bld")) {
      map.setLayoutProperty("bld", "visibility", view === "3d" ? "visible" : "none");
      map.setPaintProperty("bld", "fill-extrusion-color", mode === "rent"
        ? ["case", ["has", "r"], rentExpr, GREY] : mode === "label" ? labelExpr("l", 0) : scoreExpr());
      map.setPaintProperty("bld", "fill-extrusion-opacity", Math.max(0.5, opac));
      map.setFilter("bld", f.bld);
    }
    document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    document.querySelectorAll("#viewSeg button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    $("#modeHint").innerHTML = {
      score: "Pink: rent <b>cheaper</b> than the label suggests. Teal: <b>pricier</b>. Grey: they match.",
      label: "Official location label of every address (Berliner Mietspiegel 2026).",
      rent: "Average net rent per m² of existing tenancies in each 100 m block (Zensus 2022).",
    }[mode];
    drawMatrix(); legend();
  }

  $("#modeSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { mode = b.dataset.mode; render(); } });
  $("#opac").addEventListener("input", (e) => { opac = e.target.value / 100; render(); });

  // ------------------------------------------------ 3D + aerial photo
  $("#viewSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    const was = view; view = b.dataset.view;
    if (view === "3d" && was !== "3d") map.easeTo({ pitch: 60, bearing: -17, zoom: Math.max(map.getZoom(), 15), duration: 1400 });
    if (view !== "3d" && was === "3d") map.easeTo({ pitch: 0, bearing: 0, duration: 900 });
    render();
  });

  const SAT_WMS = "https://gdi.berlin.de/services/wms/truedop_2025_sommer";
  async function satTiles() {
    const w = DIAG.wms;                     // checked by the GitHub Action: layer name + CORS
    if (w && w.layer && w.cors) {
      return { tiles: [`${SAT_WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${encodeURIComponent(w.layer)}&STYLES=&FORMAT=image/jpeg&CRS=EPSG:3857&WIDTH=512&HEIGHT=512&BBOX={bbox-epsg-3857}`],
        tileSize: 512, maxzoom: 20, attribution: "Luftbild TrueDOP20 Sommer 2025 © Geoportal Berlin (dl-de/zero-2-0)" };
    }
    const esri = { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" };
    if (w && w.cors === false) return esri;
    try {
      const t = await fetch(`${SAT_WMS}?SERVICE=WMS&REQUEST=GetCapabilities`).then((r) => { if (!r.ok) throw 0; return r.text(); });
      const names = [...t.matchAll(/<Layer[^>]*>\s*<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
      const name = names.find((n) => /dop/i.test(n) && !/cir|ir$/i.test(n)) || names.at(-1);
      if (!name) throw 0;
      return { tiles: [`${SAT_WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${encodeURIComponent(name)}&STYLES=&FORMAT=image/jpeg&CRS=EPSG:3857&WIDTH=512&HEIGHT=512&BBOX={bbox-epsg-3857}`],
        tileSize: 512, maxzoom: 20, attribution: "Luftbild TrueDOP20 Sommer 2025 © Geoportal Berlin (dl-de/zero-2-0)" };
    } catch {
      return esri;
    }
  }
  $("#baseSeg").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    document.querySelectorAll("#baseSeg button").forEach((x) => x.classList.toggle("on", x === b));
    const on = b.dataset.base === "sat";
    if (on && !map.getSource("sat")) {
      map.addSource("sat", { type: "raster", ...(await satTiles()) });
      map.addLayer({ id: "sat", type: "raster", source: "sat", paint: { "raster-opacity": 1 } }, "cells");
    }
    if (map.getLayer("sat")) map.setLayoutProperty("sat", "visibility", on ? "visible" : "none");
    if (on && opac > 0.6) { opac = 0.55; $("#opac").value = 55; render(); }
  });

  // ------------------------------------------------ legend
  function legend() {
    let h;
    if (mode === "rent") {
      const g = RENT.map(([v, c]) => `${c} ${((v - RENT[0][0]) / (RENT.at(-1)[0] - RENT[0][0])) * 100}%`).join(",");
      h = `<div class="lg-title">Average net rent, €/m²</div>
        <div class="lg-sub">Existing tenancies, May 2022, per 100 m block.</div>
        <div class="lg-bar" style="background:linear-gradient(90deg,${g})"></div>
        <div class="lg-ticks mono">${RENT.map(([v]) => `<span>${v}</span>`).join("")}</div>
        <div class="lg-ends"><span>cheaper</span><span>Berlin thirds at ${q1} and ${q2} €</span><span>pricier</span></div>`;
    } else if (mode === "label") {
      h = `<div class="lg-title">Official location label</div><div class="lg-sub">Berliner Mietspiegel 2026, by address.</div>
        ${LABELS.map((l, i) => `<div class="lg-row"><i style="background:${l.c}"></i><b>${l.en}</b> <small>(${l.key})</small><small class="mono" style="margin-left:auto">${fmt(B.by_label[i].n)}</small></div>`).join("")}`;
    } else {
      h = `<div class="lg-title">Score: rent level − label level</div><div class="lg-sub">Does the block's rent match its official label?</div>
        ${["-2", "-1", "0", "1", "2"].map((k) => `<div class="lg-row"><i class="sq" style="background:${SCORE[k].c}"></i><span class="mono sc">${+k > 0 ? "+" + k : k}</span>${SCORE[k].t}</div>`).join("")}`;
    }
    if (view === "3d") h += `<div class="lg-row lg-note"><i class="sq" style="background:${GREY}"></i><small>Building without label or rent · height = LoD2 measured height</small></div>`;
    if (sel) h += `<div class="lg-sel">Showing only: <b>${LABELS[sel.L - 1].en}</b> label × <b>${LEVEL_R[sel.R]}</b> <button id="lgClear">show all</button></div>`;
    $("#legend").innerHTML = h;
    $("#lgClear")?.addEventListener("click", () => { sel = null; render(); });
  }

  // ------------------------------------------------ scoreboard (puantaj)
  const M = B.matrix_addresses, MT = M.flat().reduce((a, b) => a + b, 0);
  function drawMatrix(hlL, hlR) {
    let h = `<div class="mx-corner"><span>label ↓ · rent →</span></div>` +
      [1, 2, 3].map((R) => `<div class="mx-col">${["", "cheapest", "middle", "priciest"][R]}<small>third</small></div>`).join("");
    for (let L = 3; L >= 1; L--) {
      h += `<div class="mx-row">${LABELS[L - 1].en}</div>`;
      for (let R = 1; R <= 3; R++) {
        const n = M[L - 1][R - 1], s = R - L, on = sel && sel.L === L && sel.R === R, hl = hlL === L && hlR === R;
        h += `<button class="mx-cell${on ? " on" : ""}${hl ? " hl" : ""}${sel && !on ? " dim" : ""}" data-l="${L}" data-r="${R}"
          style="background:${SCORE[s].c};color:${Math.abs(s) === 2 ? "#fff" : "var(--ink)"}" title="${SCORE[s].t}: ${fmt(n)} addresses">
          <b class="mono">${s > 0 ? "+" + s : s}</b><span>${((n / MT) * 100).toFixed(0)}%</span></button>`;
      }
    }
    $("#matrix").innerHTML = h;
  }
  $("#matrix").addEventListener("click", (e) => {
    const c = e.target.closest(".mx-cell"); if (!c) return;
    const L = +c.dataset.l, R = +c.dataset.r;
    sel = sel && sel.L === L && sel.R === R ? null : { L, R };
    render();
  });
  const SA = B.score_addresses, ST = Object.values(SA).reduce((a, b) => a + b, 0);
  $("#scorebar").innerHTML = `<div class="sbar">${["-2", "-1", "0", "1", "2"].map((k) =>
    `<i style="width:${(SA[k] / ST) * 100}%;background:${SCORE[k].c}" title="${SCORE[k].t}: ${fmt(SA[k])}"></i>`).join("")}</div>
    <div class="sbar-l"><span class="t-cheap">${Math.round(((SA["-2"] + SA["-1"]) / ST) * 100)}% cheaper</span>
    <span>${Math.round((SA["0"] / ST) * 100)}% as labelled</span>
    <span class="t-pricey">${Math.round(((SA["1"] + SA["2"]) / ST) * 100)}% pricier</span></div>`;
  $("#downloads").innerHTML = `<span>Download the score tables (CSV):</span>
    <a href="data/scores_addresses.csv.zip" download>Addresses</a>
    ${hasBcsv ? `<a href="data/scores_buildings.csv.zip" download>Buildings</a>` : ""}
    <a href="data/scores_planungsraum.csv" download>Planning areas</a>`;

  // ------------------------------------------------ headline
  const [E, , G] = B.by_label;
  $("#bigNum").innerHTML = `<em>+${Math.round((G.mean / E.mean - 1) * 100)}%</em> rent`;
  $("#bigHint").innerHTML = `Addresses labelled <b>good</b> pay on average <b>${G.mean.toFixed(2)} €/m²</b>, <b>simple</b> ones ${E.mean.toFixed(2)} €/m². But the ranges overlap: a quarter of “good” addresses pay less than ${G.p25.toFixed(2)} €, a quarter of “simple” ones more than ${E.p75.toFixed(2)} €.`;
  const lo = 5.5, hi = 11, pos = (v) => `${((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * 100}%`;
  $("#lbars").innerHTML = LABELS.map((l, i) => {
    const s = B.by_label[i];
    return `<div class="lbar"><span>${l.en}</span><div class="tr">
      <div class="iqr" style="left:${pos(s.p25)};width:calc(${pos(s.p75)} - ${pos(s.p25)});background:${l.c}"></div>
      <div class="med" style="left:${pos(s.median)};background:${l.c}"></div></div><span class="v mono">${s.median.toFixed(2)} €</span></div>`;
  }).join("") + `<div class="axis"><span></span><div class="mono"><span>${lo}</span><span>8</span><span>${hi} €/m²</span></div><span></span></div>
    <p class="hint">Bar: middle half of addresses. Tick: median.</p>`;

  // ------------------------------------------------ districts + planning areas
  const pct = (v) => `${Math.round(v * 100)}%`;
  $("#dist").innerHTML = STATS.districts.map((d) => `
    <li data-k="d:${d.name}"><span>${d.name}<div class="stack">
      <i style="width:${pct(d.share_cheaper)};background:${SCORE["-1"].c}"></i><i style="width:${pct(d.share_as_label)};background:${SCORE["0"].c}"></i><i style="width:${pct(d.share_pricier)};background:${SCORE["1"].c}"></i></div></span>
      <span class="v mono">${d.mean_rent.toFixed(2)} €</span></li>`).join("");
  const plrItem = (p) => `<li data-k="p:${p.planungsraum}"><span>${p.planungsraum}<small>${p.bezirk}</small></span><b class="mono">${p.mean_score > 0 ? "+" : ""}${p.mean_score.toFixed(2)}</b></li>`;
  $("#plrCheap").innerHTML = STATS.plr_cheaper.slice(0, 6).map(plrItem).join("");
  $("#plrPricey").innerHTML = STATS.plr_pricier.slice(0, 6).map(plrItem).join("");
  const boxes = new Map([...STATS.districts.map((d) => ["d:" + d.name, d.bbox]),
    ...STATS.plr_cheaper.concat(STATS.plr_pricier).map((p) => ["p:" + p.planungsraum, p.bbox])]);
  const pad = () => (innerWidth > 860 ? { left: 420, top: 60, right: 60, bottom: 90 } : 30);
  document.querySelectorAll("#dist, #plrCheap, #plrPricey").forEach((ol) => ol.addEventListener("click", (e) => {
    const li = e.target.closest("li"); if (!li) return;
    const bb = boxes.get(li.dataset.k); if (bb) map.fitBounds(bb, { padding: pad(), maxZoom: 15.5 });
    document.querySelectorAll(".rank li, .mini-list li").forEach((x) => x.classList.toggle("on", x === li));
  }));

  // ------------------------------------------------ details, popups, tooltip
  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px", offset: 12 });
  const tag = (i) => `<span class="tag" style="background:${LABELS[i].c};color:${i ? "#fff" : "#1f2a36"}">${LABELS[i].en}</span>`;
  const scoreTag = (s) => `<span class="tag" style="background:${SCORE[s].c};color:${Math.abs(s) === 2 ? "#fff" : "var(--ink)"}">score ${s > 0 ? "+" + s : s}</span>`;
  function rentLine(r, unsure) {
    if (r == null) return `<small>No Zensus rent for this block (too few rented flats).</small>`;
    return `Block rent <b class="mono">${(+r).toFixed(2)} €/m²</b>${unsure ? " <small>(less reliable)</small>" : ""}<small>${LEVEL_R[levelR(+r)]} in Berlin</small>`;
  }
  function verdict(L, r) {
    const R = levelR(r); if (!R) return "";
    const s = R - L;
    return `<p class="verdict" style="border-color:${SCORE[s].c}">${scoreTag(s)} <b>${SCORE[s].t}.</b> ${SCORE[s].s}</p>`;
  }
  function addrHTML(i) {
    return `<div class="pop"><b>${A.streets[A.s[i]]} ${A.h[i]}</b><small>${A.plrs[A.p[i]]}</small>${tag(A.c[i])}<br>${rentLine(A.r[i])}${verdict(A.c[i] + 1, A.r[i])}</div>`;
  }
  function cellHTML(p) {
    const n = +p.n, sh = (k) => Math.round((+p[k] / n) * 100);
    return `<div class="pop"><b>100 m block</b><small class="mono">${p.id}</small>
      ${rentLine(+p.r, +p.u)}<div class="stack" style="margin:8px 0 4px">${["e", "m", "g"].map((k, i) => `<i style="width:${sh(k)}%;background:${LABELS[i].c}"></i>`).join("")}</div>
      <small>${n} addresses · simple ${sh("e")}% · medium ${sh("m")}% · good ${sh("g")}%</small>${verdict(+p.L, +p.r)}</div>`;
  }
  function bldHTML(p) {
    const l = +p.l, r = p.r == null ? null : +p.r;
    return `<div class="pop"><b>Building</b><small>${(+p.h).toFixed(0)} m high · ${+p.n || "no"} labelled address${+p.n === 1 ? "" : "es"}</small>
      ${l >= 0 ? tag(l) + "<br>" : "<small>No Mietspiegel label (no residential address)</small>"}${rentLine(r)}${l >= 0 ? verdict(l + 1, r) : ""}</div>`;
  }
  function detailCard(i) {
    const L = A.c[i] + 1, R = levelR(A.r[i]);
    $("#detail").hidden = false;
    $("#detail").innerHTML = `<button class="close" aria-label="Close" id="dClose">×</button>
      <h3>${A.streets[A.s[i]]} ${A.h[i]}</h3><p class="hint" style="margin:0 0 8px">${A.plrs[A.p[i]]}</p>
      <div class="kpis"><div class="kpi"><b>${LABELS[L - 1].en}</b><span>official label (level ${L})</span></div>
        <div class="kpi"><b>${A.r[i] == null ? "–" : A.r[i].toFixed(2) + " €"}</b><span>block rent per m²</span></div>
        <div class="kpi"><b style="color:${R ? SCORE[R - L].c : "inherit"}">${R ? (R - L > 0 ? "+" : "") + (R - L) : "–"}</b><span>score</span></div></div>
      ${R ? `<p class="verdict" style="border-color:${SCORE[R - L].c}"><b>${SCORE[R - L].t}.</b> The block's rent is in Berlin's <b>${LEVEL_R[R]}</b>, the label is <b>${LABELS[L - 1].en}</b>.</p>`
        : `<p class="verdict">No Zensus rent was published for this block, so it has no score.</p>`}`;
    $("#dClose").onclick = () => { $("#detail").hidden = true; map.setFilter("hl", ["==", ["id"], -1]); drawMatrix(); };
    drawMatrix(L, R);
  }
  function showAddr(i, fly) {
    const ll = [A.lon[i] / 1e5, A.lat[i] / 1e5];
    map.setFilter("hl", ["==", ["id"], i]);
    if (fly) map.flyTo({ center: ll, zoom: view === "3d" ? 17 : 16.5, speed: 1.6 });
    popup.setLngLat(ll).setHTML(addrHTML(i)).addTo(map);
    detailCard(i);
  }
  const visible = (id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none";
  function pick(pt, r = 6) {
    const box = [[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]];
    if (visible("dots")) { const f = map.queryRenderedFeatures(box, { layers: ["dots"] })[0]; if (f) return { k: "a", f }; }
    if (visible("bld")) { const f = map.queryRenderedFeatures(pt, { layers: ["bld"] })[0]; if (f) return { k: "b", f }; }
    if (visible("cells")) { const f = map.queryRenderedFeatures(pt, { layers: ["cells"] })[0]; if (f) return { k: "c", f }; }
    return null;
  }
  map.on("click", (e) => {
    const h = pick(e.point); if (!h) return;
    if (h.k === "a") showAddr(h.f.id, false);
    else popup.setLngLat(e.lngLat).setHTML(h.k === "b" ? bldHTML(h.f.properties) : cellHTML(h.f.properties)).addTo(map);
  });
  const tip = $("#tip");
  map.on("mousemove", (e) => {
    const h = map.loaded() ? pick(e.point, 4) : null;
    map.getCanvas().style.cursor = h ? "pointer" : "";
    if (!h || innerWidth <= 860) { tip.hidden = true; return; }
    const p = h.f.properties;
    let s = p.s ?? (h.k === "c" ? p.s : undefined);
    const lbl = h.k === "b" ? (+p.l >= 0 ? LABELS[+p.l].en : "no label") : LABELS[(+p.L || 1) - 1].en;
    const rent = h.k === "a" ? A.r[h.f.id] : p.r;
    tip.innerHTML = `<span class="dot" style="background:${s == null ? GREY : SCORE[s].c}"></span><b>${h.k === "a" ? A.streets[A.s[h.f.id]] + " " + A.h[h.f.id] : h.k === "b" ? "Building" : "100 m block"}</b>
      <small>${lbl} label · ${rent == null ? "no rent data" : (+rent).toFixed(2) + " €/m²"}${s == null ? "" : " · score " + (s > 0 ? "+" : "") + s}</small>`;
    tip.style.left = e.point.x + "px"; tip.style.top = e.point.y + "px"; tip.hidden = false;
  });
  map.on("mouseout", () => (tip.hidden = true));

  // ------------------------------------------------ search
  $("#streetList").innerHTML = A.streets.map((s) => `<option value="${s}">`).join("");
  const streetIdx = new Map(A.streets.map((s, i) => [s.toLowerCase(), i]));
  function search() {
    const s = streetIdx.get($("#qStreet").value.trim().toLowerCase());
    const no = $("#qNo").value.trim().toLowerCase().replace(/^0+/, "").replace(/\s+/g, "");
    if (s == null) { $("#qMsg").textContent = "Street not found. Pick a name from the list."; return; }
    let best = -1, any = -1;
    for (let i = 0; i < N; i++) {
      if (A.s[i] !== s) continue;
      if (any < 0) any = i;
      if (no && A.h[i].toLowerCase() === no) { best = i; break; }
    }
    $("#qMsg").textContent = best >= 0 || !no ? "" : "House number not found; showing the street.";
    showAddr(best >= 0 ? best : any, true);
  }
  $("#qGo").addEventListener("click", search);
  ["#qStreet", "#qNo"].forEach((id) => $(id).addEventListener("keydown", (e) => e.key === "Enter" && search()));

  // ------------------------------------------------ intro, footer
  let seen = false;
  try { seen = localStorage.getItem("d1-intro") === "1"; } catch {}
  if (!seen) $("#intro").hidden = false;
  $("#introGo").addEventListener("click", () => { $("#intro").hidden = true; try { localStorage.setItem("d1-intro", "1"); } catch {} $("#qStreet").focus(); });

  const gh = location.hostname.match(/^([^.]+)\.github\.io$/), repo = location.pathname.split("/").filter(Boolean)[0];
  if (gh && repo) $("#repoLink").href = `https://github.com/${gh[1]}/${repo}`;
  const missing = B.n_wfs - B.n, Bb = STATS.buildings;
  $("#coverage").innerHTML = `<b>Coverage.</b> ${fmt(B.n)} of ${fmt(B.n_wfs)} addresses in the 2026 location map${missing > 0 ? ` (${fmt(missing)} not yet loaded)` : ""}; ${Math.round(B.with_rent * 100)}% of them lie in a block with a published Zensus rent.` +
    (Bb ? ` ${fmt(Bb.total)} LoD2 buildings, ${fmt(Bb.labelled)} of them with a label.` : "");
  drawMatrix(); legend();
})();
