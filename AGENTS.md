# HDR parameter suggestion (`hdr-suggest`)

CLI that reads 2 or 3 IMX900 `.bin` or `.raw` frames (long brightest first, then short) and prints suggested CHDR viewer settings: black level, composite gain (dB), conversion gain, low/high thresholds, blend, tone. Each section cites a measured number.

```
uv run hdr-suggest LONG.bin [MID.bin] SHORT.bin
uv run hdr-suggest LONG.raw MID.raw SHORT.raw --black 240
```

- Spec and algorithm: [`hdr_backend_plan.md`](hdr_backend_plan.md). Package: `hdr_suggest`.
- `.bin` black comes from optical-black rows. `.raw` has no OB: `--black` is required unless a `.bin` is in the same run. Never guess black from image content.
- Do not auto-sort frames. Conversion gain is 1 on pairs with the same `--cg-mode`. A pair that is `hcg` vs `lcg` puts leftover ratio in conversion gain. Typed exposures are not the gain unless that pair is mixed (`--exposures` / `--cam-gain-db` then set the dB remainder).
- 3F Mid–Short low/high are Long-scale: Long–Mid thresholds × Long–Mid gain, rounded to 100 (3430/3730 → 6800/7400 on `data/3f`).
- Example set: `data/3f/` (`long-13p2-9db.bin`, `mid-6p6-9db.bin`, `short-3p3-9db.bin`). For 2F, pass long + short only (skip mid). Viewer screenshots of that 3F run: `data/3f/viewer/hdr-3f.png`, `data/3f/viewer/map-3f.png`.
- HCG/LCG pair: `data/hcg-lcg/` with `--cg-mode hcg lcg`. Viewer: `data/hcg-lcg/viewer/hdr.png`, `data/hcg-lcg/viewer/map.png`.

# Curve explorer (`hdr-curves`)

Local page that redraws the CHDR gain, threshold, and tone curves as you move the viewer knobs, plus a synthetic Map of a fake scene. 2F or 3F. Explains the curves; it does not composite real frames. 3F uses four thresholds and two blend windows (Function 5: red long, yellow LM-blend, purple mid, green MS-blend, cyan short). Mid–Short Low/High are Long-scale.

```
uv run hdr-curves
```

Opens on http://127.0.0.1:10000/ (`--port` to change). Package: `hdr_curves`. Formulas live in `hdr_curves/model.py`; the page JS mirrors them. Tone is a labeled shadow-lift illustration (0 = linear), not Sony’s internal mapper. Presets cover `data/3f` 2F/3F and HCG/LCG; you can also load `hdr-suggest --json` (first pair).

# Preview images

Viewable PNGs of unpacked raw frames. Demosaic and white balance only. Linear 8-bit (no gamma). Do not auto-stretch or otherwise enhance contrast: a common 12-bit white point keeps exposure/gain differences visible.

## Source

Headerless uint16 little-endian, row-major. Read width, height, bit depth, and Bayer pattern from the filename.

`image-short_w2064_h1552_12b_RGGB_unpacked.raw`

- 2064×1552
- 12-bit values, right-aligned in the 16-bit word (0..4095)
- RGGB, phase at pixel (0, 0)
- Black level 240. Leave it in the raw file. Subtract it only for the preview.

## Processing

1. Subtract black level 240 and clip at 0.
2. Bilinear-demosaic the Bayer pattern.
3. Gray-world white balance.
4. Scale by the 12-bit white point (4095 − 240). Same scale for every frame. Do not percentile-stretch or auto-contrast.
5. Write linear 8-bit RGB. Do not apply gamma.

## Output

- Same directory as the raw file.
- Same filename with `_preview` before `.png`.

`image-short_w2064_h1552_12b_RGGB_unpacked_preview.png`

The width and height in the name describe the raw frame, not the PNG.

- Full-color RGB. Do not quantize to a palette.
- Each file must be under 100KB. Downscale with Lanczos, as large as possible within that limit. 340×256 meets it for these frames.
- Use Pillow from `.venv` (`uv add pillow` if it is missing).
