/**
 * Curve explorer UI.
 * Formulas mirrored from hdr_curves/model.py — keep them in sync.
 */

"use strict";

const PRESETS = {
  "3f2f": {
    frames: 2,
    black: 240,
    bits: 12,
    gainDb: 11.95,
    conversion: 1,
    matchRatio: true,
    trueRatio: null,
    low: 3430,
    high: 3730,
    blend: 0.5,
    tone: 1,
  },
  "3f": {
    frames: 3,
    black: 240,
    bits: 12,
    gainDb: 5.96,
    conversion: 1,
    gainDb2: 5.97,
    conversion2: 1,
    matchRatio: true,
    trueRatio: null,
    low: 3430,
    high: 3730,
    blend: 0.5,
    low2: 6800,
    high2: 7400,
    blend2: 0.5,
    tone: 1,
  },
  "hcg-lcg": {
    frames: 2,
    black: 240,
    bits: 12,
    gainDb: 0,
    conversion: 2.9,
    matchRatio: true,
    trueRatio: null,
    low: 3430,
    high: 3730,
    blend: 0.5,
    tone: 0,
  },
};

// --- formulas (hdr_curves/model.py) ---

function gainLinear(gainDb, conversion) {
  return Math.pow(10, gainDb / 20) * conversion;
}

function frameCodes(luminance, trueRatio, appliedGain, clipEff) {
  const longCode = Math.min(luminance, clipEff);
  const shortCode = Math.min(luminance / trueRatio, clipEff);
  const shortGained = shortCode * appliedGain;
  return { longCode, shortCode, shortGained };
}

function composite(longCode, shortGained, low, high, blend) {
  if (longCode < low) return longCode;
  if (longCode >= high) return shortGained;
  return blend * longCode + (1 - blend) * shortGained;
}

function tone8bit(value, peak, tone) {
  const x = Math.min(Math.max(value / peak, 0), 1);
  if (tone === 0) return 255 * x;
  const exponent = 1 / (1 + 0.45 * tone);
  return 255 * Math.pow(x, exponent);
}

function syntheticPeak(clipEff, appliedGain) {
  return clipEff * appliedGain;
}

function bitScale(bits) {
  return Math.pow(2, bits - 12);
}

function defaultNoiseSigma(bits) {
  return 2.6 * bitScale(bits);
}

/** RGGB offsets at 12-bit (R +8, Gr 0, Gb 0, B −8), scaled to native LSB. */
function bayerOffsetAt(row, col, scale) {
  const evenRow = row % 2 === 0;
  const evenCol = col % 2 === 0;
  if (evenRow && evenCol) return 8 * scale;
  if (evenRow && !evenCol) return 0;
  if (!evenRow && evenCol) return 0;
  return -8 * scale;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianNoise(rand, sigma) {
  if (sigma <= 0) return 0;
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const SEAM_W = 64;
const SEAM_H = 48;
const SEAM_SEED = 0x5ead201;

// --- DOM ---

const els = {
  frames: document.getElementById("frames"),
  preset: document.getElementById("preset"),
  jsonFile: document.getElementById("json-file"),
  black: document.getElementById("black"),
  bits: document.getElementById("bits"),
  pair1Title: document.getElementById("pair1-title"),
  pair2: document.getElementById("pair2"),
  gainDb: document.getElementById("gain-db"),
  gainDbOut: document.getElementById("gain-db-out"),
  conversion: document.getElementById("conversion"),
  conversionOut: document.getElementById("conversion-out"),
  matchRatio: document.getElementById("match-ratio"),
  matchRatioLabel: document.getElementById("match-ratio-label"),
  trueRatioWrap: document.getElementById("true-ratio-wrap"),
  trueRatio: document.getElementById("true-ratio"),
  trueRatioOut: document.getElementById("true-ratio-out"),
  low: document.getElementById("low"),
  lowOut: document.getElementById("low-out"),
  high: document.getElementById("high"),
  highOut: document.getElementById("high-out"),
  blend: document.getElementById("blend"),
  blendOut: document.getElementById("blend-out"),
  blend1Title: document.getElementById("blend1-title"),
  gainDb2: document.getElementById("gain-db2"),
  gainDb2Out: document.getElementById("gain-db2-out"),
  conversion2: document.getElementById("conversion2"),
  conversion2Out: document.getElementById("conversion2-out"),
  low2: document.getElementById("low2"),
  low2Out: document.getElementById("low2-out"),
  high2: document.getElementById("high2"),
  high2Out: document.getElementById("high2-out"),
  blend2: document.getElementById("blend2"),
  blend2Out: document.getElementById("blend2-out"),
  tone: document.getElementById("tone"),
  toneOut: document.getElementById("tone-out"),
  noise: document.getElementById("noise"),
  noiseOut: document.getElementById("noise-out"),
  readout: document.getElementById("readout"),
  notes: document.getElementById("notes"),
  plotGain: document.getElementById("plot-gain"),
  plotThresh: document.getElementById("plot-thresh"),
  plotTone: document.getElementById("plot-tone"),
  plotMap: document.getElementById("plot-map"),
  plotSeam: document.getElementById("plot-seam"),
  seamCaption: document.getElementById("seam-caption"),
  synthView: document.querySelectorAll('input[name="synth-view"]'),
  capGain: document.querySelector("#plot-gain")?.closest("figure")?.querySelector("figcaption"),
  capThresh: document.querySelector("#plot-thresh")?.closest("figure")?.querySelector("figcaption"),
  capMap: document.querySelector(".synth-figure")?.querySelector("figcaption"),
};

const MAP_FILL_2F = {
  long: "#00d5d5",
  blend: "#3ddc64",
  short: "#f03a3a",
};

const MAP_FILL_3F = {
  long: "#e30613",
  lm_blend: "#f4d03f",
  mid: "#7b2cbf",
  ms_blend: "#3ddc64",
  short: "#00d5d5",
};

function region2f(longCode, low, high) {
  if (longCode < low) return "long";
  if (longCode >= high) return "short";
  return "blend";
}

function region3f(longCode, midGained, low, high, low2, high2) {
  let stage1;
  let c1;
  if (longCode < low) {
    stage1 = "long";
    c1 = longCode;
  } else if (longCode >= high) {
    stage1 = "mid";
    c1 = midGained;
  } else {
    stage1 = "lm_blend";
    c1 = longCode;
  }
  if (c1 < low2) return stage1;
  if (c1 >= high2) return "short";
  return "ms_blend";
}

let applyingPreset = false;

function readState() {
  const black = Number(els.black.value);
  const bits = Number(els.bits.value);
  const clip = Math.pow(2, bits) - 1;
  const clipEff = clip - black;
  const is3f = els.frames.value === "3";
  const gainDb = Number(els.gainDb.value);
  const conversion = Number(els.conversion.value);
  const g = gainLinear(gainDb, conversion);
  const gainDb2 = Number(els.gainDb2.value);
  const conversion2 = Number(els.conversion2.value);
  const g2 = gainLinear(gainDb2, conversion2);
  const matchRatio = is3f ? true : els.matchRatio.checked;
  const trueRatio = matchRatio ? g : Number(els.trueRatio.value);
  const trueRatio2 = g2;
  return {
    is3f,
    black,
    bits,
    clip,
    clipEff,
    gainDb,
    conversion,
    g,
    gainDb2,
    conversion2,
    g2,
    matchRatio,
    trueRatio,
    trueRatio2,
    low: Number(els.low.value),
    high: Number(els.high.value),
    blend: Number(els.blend.value),
    low2: Number(els.low2.value),
    high2: Number(els.high2.value),
    blend2: Number(els.blend2.value),
    tone: Number(els.tone.value),
    noise: Number(els.noise.value),
    mapView: document.querySelector('input[name="synth-view"]:checked')?.value || "map",
  };
}

function setOutputs(state) {
  els.gainDbOut.textContent = state.gainDb.toFixed(2);
  els.conversionOut.textContent = state.conversion.toFixed(2);
  els.trueRatioOut.textContent = state.trueRatio.toFixed(2);
  els.lowOut.textContent = String(Math.round(state.low));
  els.highOut.textContent = String(Math.round(state.high));
  els.blendOut.textContent = state.blend.toFixed(2);
  els.gainDb2Out.textContent = state.gainDb2.toFixed(2);
  els.conversion2Out.textContent = state.conversion2.toFixed(2);
  els.low2Out.textContent = String(Math.round(state.low2));
  els.high2Out.textContent = String(Math.round(state.high2));
  els.blend2Out.textContent = state.blend2.toFixed(2);
  els.toneOut.textContent = String(state.tone);
  els.noiseOut.textContent = state.noise.toFixed(1);
  els.pair2.classList.toggle("hidden", !state.is3f);
  els.matchRatioLabel.classList.toggle("hidden", state.is3f);
  els.trueRatioWrap.classList.toggle("hidden", state.is3f || state.matchRatio);
  els.pair1Title.textContent = state.is3f ? "Long–Mid (HG–LG)" : "Long–Short (HG)";
  els.blend1Title.textContent = state.is3f ? "Blend β (Mid–Long)" : "Blend α";
  if (els.capGain) {
    els.capGain.textContent = state.is3f
      ? "1. Composite gain — long / mid×G / short×G"
      : "1. Composite gain — long vs short×G";
  }
  if (els.capThresh) {
    els.capThresh.textContent = state.is3f
      ? "2. Threshold stitch — red long, yellow LM, purple mid, green MS, cyan short"
      : "2. Threshold stitch — cyan long, green blend, red short";
  }
  if (els.capMap) {
    if (state.mapView === "grey") {
      els.capMap.textContent =
        "4. Synthetic grey + seam zoom — stitched + tone (not a real frame)";
    } else {
      els.capMap.textContent = state.is3f
        ? "4. Synthetic Map + seam zoom — 3F regions (not a real frame)"
        : "4. Synthetic Map + seam zoom — Low/High (not a real frame)";
    }
  }
  if (els.seamCaption) {
    if (state.mapView === "grey") {
      els.seamCaption.textContent = state.matchRatio
        ? "Grey stitch of the same pixels. Uncheck “Short matches this gain” to see mottling from gain error."
        : "Grey stitch with mismatched G vs true ratio — mottling in the blend band.";
    } else if (state.is3f) {
      els.seamCaption.textContent =
        "Yellow is the Long–Mid blend window; other colours crossed a threshold from Bayer and noise.";
    } else {
      els.seamCaption.textContent =
        "Green is the blend window; cyan/red dots crossed Low/High from Bayer and noise. Tighten Low/High or raise seam noise to see more speckles.";
    }
  }

  const gTotal = state.is3f ? state.g * state.g2 : state.g;
  const seamMatch = Math.abs(state.trueRatio - state.g) / state.g < 0.01;
  els.readout.textContent = state.is3f
    ? `G_LM = ${state.g.toFixed(3)}  ·  G_MS = ${state.g2.toFixed(3)}  ·  chain G = ${gTotal.toFixed(3)}  ·  clip = ${state.clipEff.toFixed(1)}  ·  peak ≈ ${(state.clipEff * gTotal).toFixed(0)}`
    : `G = ${state.g.toFixed(3)}  ·  clip after black = ${state.clipEff.toFixed(1)}` +
      `  ·  seam ${seamMatch ? "matches (R ≈ G)" : "mismatched (kink at switch)"}` +
      `  ·  synthetic peak ≈ ${(state.clipEff * state.g).toFixed(0)}`;

  const notes = [];
  if (!state.is3f && seamMatch) {
    notes.push("Matched gain: blend does not move the stitched curve.");
  }
  if (state.high > state.clipEff) {
    notes.push(
      state.is3f
        ? "LM High is above clip: long never reaches it, so Mid is never selected from Long."
        : "High is above clip-after-black: long never reaches High, so short is never selected.",
    );
  }
  if (state.low >= state.high) {
    notes.push("Low ≥ High: first blend window is empty.");
  }
  if (state.is3f && state.low2 >= state.high2) {
    notes.push("MS Low ≥ High: second blend window is empty.");
  }
  els.notes.textContent = notes.join(" ");
}

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  applyingPreset = true;
  els.frames.value = String(p.frames ?? 2);
  els.black.value = String(p.black);
  els.bits.value = String(p.bits);
  els.gainDb.value = String(p.gainDb);
  els.conversion.value = String(p.conversion);
  els.matchRatio.checked = p.matchRatio;
  const g = gainLinear(p.gainDb, p.conversion);
  els.trueRatio.value = String(p.trueRatio ?? g);
  els.low.value = String(p.low);
  els.high.value = String(p.high);
  els.blend.value = String(p.blend);
  els.gainDb2.value = String(p.gainDb2 ?? 5.97);
  els.conversion2.value = String(p.conversion2 ?? 1);
  els.low2.value = String(p.low2 ?? 6800);
  els.high2.value = String(p.high2 ?? 7400);
  els.blend2.value = String(p.blend2 ?? 0.5);
  els.tone.value = String(p.tone);
  els.noise.value = String(defaultNoiseSigma(p.bits));
  applyingPreset = false;
  redraw();
}

function markCustom() {
  if (!applyingPreset) els.preset.value = "custom";
}

function sampleCurve(state, n = 240) {
  const gTotal = state.is3f ? state.g * state.g2 : state.g;
  const peak = syntheticPeak(state.clipEff, gTotal);
  const xMax = Math.max(peak * 1.05, state.clipEff * 1.2);
  const xs = [];
  const longY = [];
  const midY = [];
  const shortY = [];
  const compY = [];
  const region = [];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * xMax;
    const longCode = Math.min(x, state.clipEff);
    xs.push(x);
    longY.push(longCode);
    if (state.is3f) {
      const midG = Math.min(x / state.trueRatio, state.clipEff) * state.g;
      const shortG =
        Math.min(x / (state.trueRatio * state.trueRatio2), state.clipEff) *
        state.g *
        state.g2;
      const c1 = composite(
        longCode,
        midG,
        state.low,
        state.high,
        1 - state.blend,
      );
      midY.push(midG);
      shortY.push(shortG);
      compY.push(
        composite(c1, shortG, state.low2, state.high2, 1 - state.blend2),
      );
      region.push(
        region3f(longCode, midG, state.low, state.high, state.low2, state.high2),
      );
    } else {
      const { shortGained } = frameCodes(
        x,
        state.trueRatio,
        state.g,
        state.clipEff,
      );
      midY.push(longCode);
      shortY.push(shortGained);
      compY.push(
        composite(longCode, shortGained, state.low, state.high, state.blend),
      );
      region.push(region2f(longCode, state.low, state.high));
    }
  }
  return { xs, longY, midY, shortY, compY, region, xMax, peak };
}

function clearSvg(svg) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function svgEl(name, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

function pathFrom(xs, ys, mapX, mapY) {
  return pathFromMask(xs, ys, mapX, mapY, () => true);
}

function pathFromMask(xs, ys, mapX, mapY, keep) {
  let d = "";
  let drawing = false;
  for (let i = 0; i < xs.length; i++) {
    if (!keep(i)) {
      drawing = false;
      continue;
    }
    const cmd = drawing ? "L" : "M";
    d += `${cmd}${mapX(xs[i]).toFixed(2)},${mapY(ys[i]).toFixed(2)} `;
    drawing = true;
  }
  return d.trim();
}

function appendPath(svg, cls, d) {
  if (!d) return;
  svg.appendChild(svgEl("path", { class: cls, d }));
}

function drawAxes(svg, pad, width, height, xMax, yMax, xLabel, yLabel) {
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const mapX = (x) => pad.l + (x / xMax) * plotW;
  const mapY = (y) => pad.t + plotH - (y / yMax) * plotH;

  for (let i = 1; i <= 4; i++) {
    const x = pad.l + (i / 4) * plotW;
    const y = pad.t + (i / 4) * plotH;
    svg.appendChild(
      svgEl("line", {
        class: "gridline",
        x1: x,
        y1: pad.t,
        x2: x,
        y2: pad.t + plotH,
      }),
    );
    svg.appendChild(
      svgEl("line", {
        class: "gridline",
        x1: pad.l,
        y1: y,
        x2: pad.l + plotW,
        y2: y,
      }),
    );
  }

  svg.appendChild(
    svgEl("rect", {
      class: "axis",
      x: pad.l,
      y: pad.t,
      width: plotW,
      height: plotH,
    }),
  );

  svg.appendChild(
    svgEl("text", {
      class: "label",
      x: pad.l + plotW / 2,
      y: height - 8,
      "text-anchor": "middle",
    }),
  ).textContent = xLabel;

  const yl = svgEl("text", {
    class: "label",
    x: 14,
    y: pad.t + plotH / 2,
    "text-anchor": "middle",
    transform: `rotate(-90 14 ${pad.t + plotH / 2})`,
  });
  yl.textContent = yLabel;
  svg.appendChild(yl);

  svg.appendChild(
    svgEl("text", {
      class: "label",
      x: pad.l,
      y: height - 22,
      "text-anchor": "start",
    }),
  ).textContent = "0";

  svg.appendChild(
    svgEl("text", {
      class: "label",
      x: pad.l + plotW,
      y: height - 22,
      "text-anchor": "end",
    }),
  ).textContent = Math.round(xMax).toString();

  svg.appendChild(
    svgEl("text", {
      class: "label",
      x: pad.l - 6,
      y: pad.t + 4,
      "text-anchor": "end",
    }),
  ).textContent = Math.round(yMax).toString();

  return { mapX, mapY, plotW, plotH };
}

function legend(svg, items, x, y) {
  const g = svgEl("g", { class: "legend" });
  items.forEach((item, i) => {
    const yy = y + i * 18;
    g.appendChild(
      svgEl("line", {
        x1: x,
        y1: yy,
        x2: x + 18,
        y2: yy,
        class: item.cls,
        ...(item.dash ? { "stroke-dasharray": item.dash } : {}),
      }),
    );
    const t = svgEl("text", { x: x + 24, y: yy + 4 });
    t.textContent = item.label;
    g.appendChild(t);
  });
  svg.appendChild(g);
}

function drawGainPlot(state, samples) {
  const svg = els.plotGain;
  clearSvg(svg);
  const pad = { l: 52, r: 16, t: 16, b: 40 };
  const width = 640;
  const height = 360;
  const yMax = samples.peak * 1.05;
  const { mapX, mapY } = drawAxes(
    svg,
    pad,
    width,
    height,
    samples.xMax,
    yMax,
    "Scene luminance (long LSB)",
    "CIS output",
  );

  svg.appendChild(
    svgEl("line", {
      class: "clip-line",
      x1: mapX(0),
      y1: mapY(state.clipEff),
      x2: mapX(samples.xMax),
      y2: mapY(state.clipEff),
    }),
  );
  svg.appendChild(
    svgEl("text", {
      class: "label",
      x: mapX(samples.xMax) - 4,
      y: mapY(state.clipEff) - 4,
      "text-anchor": "end",
    }),
  ).textContent = "AD clip";

  svg.appendChild(
    svgEl("path", {
      class: "curve-long",
      d: pathFrom(samples.xs, samples.longY, mapX, mapY),
    }),
  );
  if (state.is3f) {
    svg.appendChild(
      svgEl("path", {
        class: "curve-mid",
        d: pathFrom(samples.xs, samples.midY, mapX, mapY),
      }),
    );
  }
  svg.appendChild(
    svgEl("path", {
      class: "curve-short",
      d: pathFrom(samples.xs, samples.shortY, mapX, mapY),
    }),
  );

  legend(svg, state.is3f
    ? [
        { cls: "curve-long", label: "Long" },
        { cls: "curve-mid", label: "Mid × G_LM" },
        { cls: "curve-short", label: "Short × G_chain" },
      ]
    : [
        { cls: "curve-long", label: "Long (HG)" },
        { cls: "curve-short", label: "Short × G" },
      ], pad.l + 12, pad.t + 18);
}

function drawThreshPlot(state, samples) {
  const svg = els.plotThresh;
  clearSvg(svg);
  const pad = { l: 52, r: 16, t: 16, b: 40 };
  const width = 640;
  const height = 360;
  const yMax = samples.peak * 1.05;
  const { mapX, mapY } = drawAxes(
    svg,
    pad,
    width,
    height,
    samples.xMax,
    yMax,
    "Scene luminance (long LSB)",
    "CIS output",
  );

  const threshLabels = state.is3f
    ? [
        [state.low, "LM Low"],
        [state.high, "LM High"],
        [state.low2, "MS Low"],
        [state.high2, "MS High"],
      ]
    : [
        [state.low, "Low"],
        [state.high, "High"],
      ];
  for (const [val, label] of threshLabels) {
    if (val < 0 || val > yMax) continue;
    svg.appendChild(
      svgEl("line", {
        class: "thresh",
        x1: pad.l,
        y1: mapY(val),
        x2: width - pad.r,
        y2: mapY(val),
      }),
    );
    svg.appendChild(
      svgEl("text", {
        class: "label",
        x: pad.l + 6,
        y: mapY(val) - 4,
      }),
    ).textContent = label;
  }

  svg.appendChild(
    svgEl("line", {
      class: "clip-line",
      x1: mapX(0),
      y1: mapY(state.clipEff),
      x2: mapX(samples.xMax),
      y2: mapY(state.clipEff),
    }),
  );

  if (state.is3f) {
    const segs = [
      ["long", "curve-3f-long"],
      ["lm_blend", "curve-3f-lm"],
      ["mid", "curve-3f-mid"],
      ["ms_blend", "curve-3f-ms"],
      ["short", "curve-3f-short"],
    ];
    for (const [name, cls] of segs) {
      appendPath(
        svg,
        cls,
        pathFromMask(
          samples.xs,
          samples.compY,
          mapX,
          mapY,
          (i) => samples.region[i] === name,
        ),
      );
    }
    legend(svg, [
      { cls: "curve-3f-long", label: "Long" },
      { cls: "curve-3f-lm", label: "LM blend" },
      { cls: "curve-3f-mid", label: "Mid" },
      { cls: "curve-3f-ms", label: "MS blend" },
      { cls: "curve-3f-short", label: "Short" },
    ], pad.l + 12, pad.t + 14);
  } else {
    appendPath(
      svg,
      "curve-map-long",
      pathFromMask(
        samples.xs,
        samples.longY,
        mapX,
        mapY,
        (i) => samples.region[i] === "long",
      ),
    );
    appendPath(
      svg,
      "curve-map-blend",
      pathFromMask(
        samples.xs,
        samples.compY,
        mapX,
        mapY,
        (i) => samples.region[i] === "blend",
      ),
    );
    appendPath(
      svg,
      "curve-map-short",
      pathFromMask(
        samples.xs,
        samples.shortY,
        mapX,
        mapY,
        (i) => samples.region[i] === "short",
      ),
    );
    legend(svg, [
      { cls: "curve-map-long", label: "Long" },
      { cls: "curve-map-blend", label: "Blend" },
      { cls: "curve-map-short", label: "Short" },
    ], pad.l + 12, pad.t + 18);
  }
}

function drawTonePlot(state, samples) {
  const svg = els.plotTone;
  clearSvg(svg);
  const pad = { l: 52, r: 16, t: 16, b: 40 };
  const width = 640;
  const height = 360;
  const { mapX, mapY } = drawAxes(
    svg,
    pad,
    width,
    height,
    samples.xMax,
    255,
    "Scene luminance (long LSB)",
    "8-bit display",
  );

  for (let t = 0; t <= 4; t++) {
    const ys = samples.compY.map((v) => tone8bit(v, samples.peak, t));
    const cls = t === state.tone ? "curve-tone" : "curve-ghost";
    svg.appendChild(
      svgEl("path", {
        class: cls,
        d: pathFrom(samples.xs, ys, mapX, mapY),
      }),
    );
  }

  legend(svg, [
    { cls: "curve-ghost", label: "Tone 0–4 (ghost)" },
    { cls: "curve-tone", label: `Tone ${state.tone} (selected)` },
  ], pad.l + 12, pad.t + 18);
}

function patchValues(state) {
  const clip = Math.max(state.clipEff, 1);
  const peak = clip * (state.is3f ? state.g * state.g2 : state.g);
  if (!state.is3f) {
    return [
      0.2 * state.low,
      0.55 * state.low,
      (state.low + state.high) / 2,
      state.high + 0.3 * Math.max(clip - state.high, 50),
      clip,
      clip + 0.25 * Math.max(peak - clip, 0),
      0.7 * peak,
      0.96 * peak,
    ];
  }
  return [
    0.25 * state.low,
    0.7 * state.low,
    (state.low + state.high) / 2,
    state.high + 0.2 * Math.max(state.low2 - state.high, 200),
    (state.low2 + state.high2) / 2,
    state.high2 * 1.08,
    0.78 * peak,
    0.96 * peak,
  ];
}

function compositeAt(state, lum) {
  const longCode = Math.min(lum, state.clipEff);
  if (!state.is3f) {
    const shortG = Math.min(lum / state.trueRatio, state.clipEff) * state.g;
    return composite(longCode, shortG, state.low, state.high, state.blend);
  }
  const midG = Math.min(lum / state.trueRatio, state.clipEff) * state.g;
  const shortG =
    Math.min(lum / (state.trueRatio * state.trueRatio2), state.clipEff) *
    state.g *
    state.g2;
  const c1 = composite(longCode, midG, state.low, state.high, 1 - state.blend);
  return composite(c1, shortG, state.low2, state.high2, 1 - state.blend2);
}

function colorOf(state, lum) {
  if (state.mapView === "grey") {
    const peak = Math.max(state.clipEff * (state.is3f ? state.g * state.g2 : state.g), 1);
    const g = Math.round(tone8bit(compositeAt(state, lum), peak, state.tone));
    return `rgb(${g},${g},${g})`;
  }
  const longCode = Math.min(lum, state.clipEff);
  if (!state.is3f) {
    return MAP_FILL_2F[region2f(longCode, state.low, state.high)];
  }
  const midG = Math.min(lum / state.trueRatio, state.clipEff) * state.g;
  return MAP_FILL_3F[
    region3f(longCode, midG, state.low, state.high, state.low2, state.high2)
  ];
}

function drawMap(state) {
  const canvas = els.plotMap;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 16, r: 16, t: 8, b: 8 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const values = patchValues(state);
  const fieldLum = values[0];
  ctx.fillStyle = colorOf(state, fieldLum);
  ctx.fillRect(pad.l, pad.t, innerW, innerH);

  const cols = 4;
  const rows = 2;
  const gap = 12;
  const cellW = (innerW - gap * (cols + 1)) / cols;
  const cellH = (innerH - gap * (rows + 1)) / rows;
  ctx.font = "12px Segoe UI, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  values.forEach((v, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad.l + gap + col * (cellW + gap);
    const y = pad.t + gap + row * (cellH + gap);
    ctx.fillStyle = colorOf(state, v);
    ctx.fillRect(x, y, cellW, cellH);
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
    let ink = "#111";
    if (state.mapView === "grey") {
      const peak = Math.max(
        state.clipEff * (state.is3f ? state.g * state.g2 : state.g),
        1,
      );
      const g = tone8bit(compositeAt(state, v), peak, state.tone);
      ink = g < 140 ? "#eee" : "#111";
    }
    ctx.fillStyle = ink;
    ctx.fillText(String(Math.round(v)), x + cellW / 2, y + cellH / 2);
  });
}

function seamMean(state) {
  return (state.low + state.high) / 2;
}

function drawSeamZoom(state) {
  const canvas = els.plotSeam;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const mean = seamMean(state);
  const scale = bitScale(state.bits);
  const rand = mulberry32(SEAM_SEED);
  const peak = Math.max(
    state.clipEff * (state.is3f ? state.g * state.g2 : state.g),
    1,
  );
  const cellW = w / SEAM_W;
  const cellH = h / SEAM_H;

  for (let r = 0; r < SEAM_H; r++) {
    for (let c = 0; c < SEAM_W; c++) {
      const scene = mean + bayerOffsetAt(r, c, scale) + gaussianNoise(rand, state.noise);
      const longCode = Math.min(Math.max(scene, 0), state.clipEff);
      let fill;
      if (state.mapView === "grey") {
        const midG = Math.min(scene / state.trueRatio, state.clipEff) * state.g;
        let stitched;
        if (state.is3f) {
          const shortG =
            Math.min(scene / (state.trueRatio * state.trueRatio2), state.clipEff) *
            state.g *
            state.g2;
          const c1 = composite(
            longCode,
            midG,
            state.low,
            state.high,
            1 - state.blend,
          );
          stitched = composite(
            c1,
            shortG,
            state.low2,
            state.high2,
            1 - state.blend2,
          );
        } else {
          stitched = composite(longCode, midG, state.low, state.high, state.blend);
        }
        const g = Math.round(tone8bit(stitched, peak, state.tone));
        fill = `rgb(${g},${g},${g})`;
      } else if (state.is3f) {
        const midG = Math.min(scene / state.trueRatio, state.clipEff) * state.g;
        fill =
          MAP_FILL_3F[
            region3f(
              longCode,
              midG,
              state.low,
              state.high,
              state.low2,
              state.high2,
            )
          ];
      } else {
        fill = MAP_FILL_2F[region2f(longCode, state.low, state.high)];
      }
      ctx.fillStyle = fill;
      ctx.fillRect(
        Math.floor(c * cellW),
        Math.floor(r * cellH),
        Math.ceil(cellW) + 1,
        Math.ceil(cellH) + 1,
      );
    }
  }
}

function redraw() {
  const state = readState();
  setOutputs(state);
  const samples = sampleCurve(state);
  drawGainPlot(state, samples);
  drawThreshPlot(state, samples);
  drawTonePlot(state, samples);
  drawMap(state);
  drawSeamZoom(state);
}

function loadSuggestJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      const pair = Array.isArray(data.pairs) ? data.pairs[0] : null;
      if (!pair) {
        els.notes.textContent = "JSON has no pairs[0].";
        return;
      }
      applyingPreset = true;
      els.preset.value = "custom";
      if (data.black != null) els.black.value = String(data.black);
      els.gainDb.value = String(pair.gain_dB ?? 0);
      els.conversion.value = String(pair.conversion_gain_ratio ?? 1);
      els.matchRatio.checked = true;
      const g = gainLinear(Number(els.gainDb.value), Number(els.conversion.value));
      els.trueRatio.value = String(g);
      els.low.value = String(pair.low ?? 3430);
      els.high.value = String(pair.high ?? 3730);
      els.blend.value = String(pair.blend ?? 0.5);
      els.tone.value = String(pair.tone ?? 1);
      const pair2 = data.pairs[1];
      if (pair2) {
        els.frames.value = "3";
        els.gainDb2.value = String(pair2.gain_dB ?? 0);
        els.conversion2.value = String(pair2.conversion_gain_ratio ?? 1);
        els.low2.value = String(pair2.low ?? 6800);
        els.high2.value = String(pair2.high ?? 7400);
        els.blend2.value = String(pair2.blend ?? 0.5);
      } else {
        els.frames.value = "2";
      }
      applyingPreset = false;
      redraw();
    } catch (err) {
      els.notes.textContent = `Could not read JSON: ${err}`;
    }
  };
  reader.readAsText(file);
}

function bind() {
  els.preset.addEventListener("change", () => {
    if (els.preset.value === "custom") return;
    applyPreset(els.preset.value);
  });
  els.frames.addEventListener("change", () => {
    markCustom();
    if (els.frames.value === "3" && PRESETS["3f"]) {
      const p = PRESETS["3f"];
      if (!els.low2.value) els.low2.value = String(p.low2);
    }
    redraw();
  });
  els.jsonFile.addEventListener("change", () => {
    const file = els.jsonFile.files && els.jsonFile.files[0];
    if (file) loadSuggestJson(file);
  });
  for (const radio of els.synthView) {
    radio.addEventListener("change", () => redraw());
  }

  const inputs = [
    els.black,
    els.bits,
    els.gainDb,
    els.conversion,
    els.matchRatio,
    els.trueRatio,
    els.low,
    els.high,
    els.blend,
    els.gainDb2,
    els.conversion2,
    els.low2,
    els.high2,
    els.blend2,
    els.tone,
    els.noise,
  ];
  for (const el of inputs) {
    el.addEventListener("input", () => {
      markCustom();
      if (el === els.matchRatio && els.matchRatio.checked) {
        const s = readState();
        els.trueRatio.value = String(s.g);
      }
      if (el === els.gainDb || el === els.conversion) {
        if (els.matchRatio.checked) {
          const s = readState();
          els.trueRatio.value = String(s.g);
        }
      }
      if (el === els.bits) {
        els.noise.value = String(defaultNoiseSigma(Number(els.bits.value)));
      }
      redraw();
    });
  }
}

bind();
applyPreset("3f2f");
