/**
 * Curve explorer UI.
 * Formulas mirrored from hdr_curves/model.py — keep them in sync.
 */

"use strict";

const PRESETS = {
  "3f2f": {
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
  "hcg-lcg": {
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
  slide: {
    black: 200,
    bits: 12,
    gainDb: 30,
    conversion: 2.6,
    matchRatio: true,
    trueRatio: null,
    low: 800,
    high: 1200,
    blend: 0.5,
    tone: 1,
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

// --- DOM ---

const els = {
  preset: document.getElementById("preset"),
  jsonFile: document.getElementById("json-file"),
  black: document.getElementById("black"),
  bits: document.getElementById("bits"),
  gainDb: document.getElementById("gain-db"),
  gainDbOut: document.getElementById("gain-db-out"),
  conversion: document.getElementById("conversion"),
  conversionOut: document.getElementById("conversion-out"),
  matchRatio: document.getElementById("match-ratio"),
  trueRatioWrap: document.getElementById("true-ratio-wrap"),
  trueRatio: document.getElementById("true-ratio"),
  trueRatioOut: document.getElementById("true-ratio-out"),
  low: document.getElementById("low"),
  lowOut: document.getElementById("low-out"),
  high: document.getElementById("high"),
  highOut: document.getElementById("high-out"),
  blend: document.getElementById("blend"),
  blendOut: document.getElementById("blend-out"),
  tone: document.getElementById("tone"),
  toneOut: document.getElementById("tone-out"),
  readout: document.getElementById("readout"),
  notes: document.getElementById("notes"),
  plotGain: document.getElementById("plot-gain"),
  plotThresh: document.getElementById("plot-thresh"),
  plotTone: document.getElementById("plot-tone"),
};

let applyingPreset = false;

function readState() {
  const black = Number(els.black.value);
  const bits = Number(els.bits.value);
  const clip = Math.pow(2, bits) - 1;
  const clipEff = clip - black;
  const gainDb = Number(els.gainDb.value);
  const conversion = Number(els.conversion.value);
  const g = gainLinear(gainDb, conversion);
  const matchRatio = els.matchRatio.checked;
  const trueRatio = matchRatio ? g : Number(els.trueRatio.value);
  return {
    black,
    bits,
    clip,
    clipEff,
    gainDb,
    conversion,
    g,
    matchRatio,
    trueRatio,
    low: Number(els.low.value),
    high: Number(els.high.value),
    blend: Number(els.blend.value),
    tone: Number(els.tone.value),
  };
}

function setOutputs(state) {
  els.gainDbOut.textContent = state.gainDb.toFixed(2);
  els.conversionOut.textContent = state.conversion.toFixed(2);
  els.trueRatioOut.textContent = state.trueRatio.toFixed(2);
  els.lowOut.textContent = String(Math.round(state.low));
  els.highOut.textContent = String(Math.round(state.high));
  els.blendOut.textContent = state.blend.toFixed(2);
  els.toneOut.textContent = String(state.tone);
  els.trueRatioWrap.classList.toggle("hidden", state.matchRatio);

  const seamMatch = Math.abs(state.trueRatio - state.g) / state.g < 0.01;
  els.readout.textContent =
    `G = ${state.g.toFixed(3)}  ·  clip after black = ${state.clipEff.toFixed(1)}` +
    `  ·  seam ${seamMatch ? "matches (R ≈ G)" : "mismatched (kink at switch)"}` +
    `  ·  synthetic peak ≈ ${(state.clipEff * state.g).toFixed(0)}`;

  const notes = [];
  if (seamMatch) {
    notes.push("Matched gain: blend does not move the stitched curve.");
  }
  if (state.high > state.clipEff) {
    notes.push(
      "High is above clip-after-black: long never reaches High, so short is never selected.",
    );
  }
  if (state.low >= state.high) {
    notes.push("Low ≥ High: blend window is empty.");
  }
  els.notes.textContent = notes.join(" ");
}

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  applyingPreset = true;
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
  els.tone.value = String(p.tone);
  applyingPreset = false;
  redraw();
}

function markCustom() {
  if (!applyingPreset) els.preset.value = "custom";
}

function sampleCurve(state, n = 240) {
  const peak = syntheticPeak(state.clipEff, state.g);
  const xMax = Math.max(peak * 1.05, state.clipEff * 1.2);
  const xs = [];
  const longY = [];
  const shortY = [];
  const compY = [];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * xMax;
    const { longCode, shortGained } = frameCodes(
      x,
      state.trueRatio,
      state.g,
      state.clipEff,
    );
    xs.push(x);
    longY.push(longCode);
    shortY.push(shortGained);
    compY.push(
      composite(longCode, shortGained, state.low, state.high, state.blend),
    );
  }
  return { xs, longY, shortY, compY, xMax, peak };
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
  let d = "";
  for (let i = 0; i < xs.length; i++) {
    const cmd = i === 0 ? "M" : "L";
    d += `${cmd}${mapX(xs[i]).toFixed(2)},${mapY(ys[i]).toFixed(2)} `;
  }
  return d.trim();
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
    const yy = y + i * 16;
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
  svg.appendChild(
    svgEl("path", {
      class: "curve-short",
      d: pathFrom(samples.xs, samples.shortY, mapX, mapY),
    }),
  );

  legend(svg, [
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

  // Thresholds compare against long-frame code (CIS Y), as in the Sony slide.
  const bandLo = Math.max(0, Math.min(state.low, yMax));
  const bandHi = Math.max(0, Math.min(state.high, yMax));
  if (bandHi > bandLo) {
    svg.appendChild(
      svgEl("rect", {
        class: "blend-band",
        x: pad.l,
        y: mapY(bandHi),
        width: width - pad.l - pad.r,
        height: Math.max(0, mapY(bandLo) - mapY(bandHi)),
      }),
    );
  }

  for (const [val, label] of [
    [state.low, "Low"],
    [state.high, "High"],
  ]) {
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

  svg.appendChild(
    svgEl("path", {
      class: "curve-long",
      d: pathFrom(samples.xs, samples.longY, mapX, mapY),
    }),
  );
  svg.appendChild(
    svgEl("path", {
      class: "curve-short",
      d: pathFrom(samples.xs, samples.shortY, mapX, mapY),
    }),
  );
  svg.appendChild(
    svgEl("path", {
      class: "curve-comp",
      d: pathFrom(samples.xs, samples.compY, mapX, mapY),
    }),
  );

  legend(svg, [
    { cls: "curve-long", label: "Long" },
    { cls: "curve-short", label: "Short × G" },
    { cls: "curve-comp", label: "Composite" },
  ], pad.l + 12, pad.t + 18);
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

function redraw() {
  const state = readState();
  setOutputs(state);
  const samples = sampleCurve(state);
  drawGainPlot(state, samples);
  drawThreshPlot(state, samples);
  drawTonePlot(state, samples);
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
  els.jsonFile.addEventListener("change", () => {
    const file = els.jsonFile.files && els.jsonFile.files[0];
    if (file) loadSuggestJson(file);
  });

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
    els.tone,
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
      redraw();
    });
  }
}

bind();
applyPreset("3f2f");
