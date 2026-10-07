# Plan: HDR test-image generator (IMX900-style global-shutter, color + mono)

Hand this file to the agent that will write the code. Everything the agent needs to decide is either specified here or listed under "Assumptions to confirm".

## 1. Goal

A command-line tool (`hdrgen`) that, given a **total HDR span in dB** (for example `--span-db 24`), produces a **set of 2 or 3 raw frames** (long / [mid] / short) plus ground truth, so an HDR merge tool can be checked numerically.

The frames must look like real IMX900 captures at the file level (pedestal, optical-black rows, padding, bit depth, Bayer or mono), and the scene must be designed to trigger the typical merge-tool bugs.

Core idea: every image is derived from one **known linear radiance map** (float32). An ideal merge returns that map, so every error is measurable.

## 2. Reference facts (from the user's real IMX900 captures)

- Full array 2064x1552 active, RGGB. Binned mode is 1032x776 GBRG (optional preset).
- Pedestal (black level) is **240 at 12-bit**; scale by 2^(bits-12): 15 at 8-bit, 60 at 10-bit.
- Real `.bin` ("Format A"): 4-byte header (width uint16 LE, height uint16 LE), then one uint16 LE word per pixel, 12-bit **right-justified**. The real file is 2080x1593: row 0 = embedded data, rows 1-40 = optical black (mean about the pedestal, std about 2.6 DN), then 1552 active rows; 16 zero-padding columns on the right.
- Real headerless `.raw`: unpacked 16-bit LE. The user's merge app reads names like `xxx_w2064_h1552_12b_RGGB_unpacked.raw` and also loads Format A `.bin`.
- Raw channel sensitivity in the real scene: G about 1.0, R about 0.55, B about 0.62 (G is about 2x R and B). Default CFA sensitivities for color.
- dB convention in the user's tool is **amplitude: ratio = 10^(dB/20)** (6.4 dB = x2.09). The tool also has a conversion-gain ratio, and the slides suggest dB and ratio **multiply** (example: 30 dB + 2.6x).
- Global shutter: no row skew. A moving object is a pure temporal offset between frames.
- Merge tool controls to exercise: black level, per-frame gain (dB), conversion-gain ratio, thresholds low/high (assumed compared on the long frame after black subtraction), blend ratio (0 = hard switch, 1 = full ramp, assumed), tone mapping (preview only).

## 3. CLI

```
hdrgen --span-db 24 --frames 3 --sensor color --bits 12 \
       --width 2064 --height 1552 --out ./out
```

| Option | Default | Meaning |
|---|---|---|
| `--span-db` | required | Total gain from the long to the shortest frame, amplitude dB. 24 dB = x15.85 |
| `--frames` | 2 | 2 (L, S) or 3 (L, M, S) |
| `--mid-db` | span/2 | Mid frame position in dB (geometric midpoint by default) |
| `--cg-ratio` | 1.0 | Split the total gain into dB part x conversion-gain ratio (`G_total = 10^(dB/20) * cg`) |
| `--mechanism` | `exposure` | `exposure`: short frame has less signal, read noise unchanged. `gain`: same electrons, DN scaled, read noise scaled |
| `--sensor` | `color` | `color` (Bayer) or `mono` |
| `--pattern` | `RGGB` | RGGB, GBRG, GRBG, BGGR (color only) |
| `--bits` | 12 | 8, 10, 12, or a list (`8,10,12`) to write all |
| `--width/--height` | 2064/1552 | Any size. Must be even for color |
| `--pedestal12` | 240 | 12-bit pedestal; scaled per bit depth |
| `--noise` | off | `off`, `on` (shot + read + column FPN), or `both` (writes two sets) |
| `--seed` | 1 | Deterministic output |
| `--layout` | `raw` | `raw`, `bin`, or `both` (see 5) |
| `--justify` | `lsb` | `lsb` (right-aligned) or `msb` (left-aligned, word>>shift) |
| `--ob-rows/--pad-cols/--embedded-rows` | 40/16/1 | Used by the `bin` layout |
| `--thr-low/--thr-high` | 0.50/0.85 | Merge thresholds as a fraction of long full scale, used to place threshold patches |
| `--scene` | `default` | Scene preset (see 4) |
| `--motion` | off | Add a moving object (ghosting test) |
| `--presets` | none | Named matrices (see 8) |

## 4. Scene engine (resolution-independent)

Define the scene in normalized coordinates (0..1), render at any WxH. Use float32 linear radiance, normalized so **L = 1.0 maps to long-frame full scale**. The brightest scene radiance is `0.9 * G_total` so the shortest frame just avoids clipping, and the darkest valid region sits a few DN above the long-frame noise floor.

Panels, each with a stable ID in the manifest:

1. **Log step wedge**: 24+ steps spanning the whole range (span plus about 8 stops of shadow). Shows which frame each tone range comes from.
2. **Smooth ramp**: log or linear across the full range. Reveals seams and banding in the blend zone.
3. **Threshold patches**: patches placed at radiance where the long frame equals the low threshold and the high threshold, each at -2, -1, 0, +1, +2 codes. Catches off-by-one, `<` vs `<=`, and pre/post black-subtraction comparison.
4. **Per-channel patches**: saturated R, G, B, C, M, Y at 4 radiance levels. With CFA sensitivities, channels clip at different brightness. A luma-based or per-pixel switch produces colour casts here.
5. **Clipped-long region**: large bright area that clips in L (and M) but is valid in S.
6. **Deep shadow**: patches near and below the noise floor.
7. **Gray neutral ramp and neutral patches** for white-balance checks.
8. **Edges and fine checker**: sharp edges between very bright and dark areas (checks merge doesn't smear across the mosaic).
9. **Optional moving object** (frames get different positions) for ghosting.

Rules for resolution independence: patch sizes scale with the image but never fall below 8x8 pixels; ramps are computed per pixel from the coordinate (no resampling); Bayer sampling happens last (each pixel takes the radiance of its own channel).

Mono: same radiance map, luminance only, no mosaic, no CFA sensitivities.

## 5. Sensor model and file writers

Per frame `k` with brightness factor `b_k` (long = 1, mid = 1/G_mid, short = 1/G_total):

```
signal_dn   = L * b_k * fullscale_dn(bits)              # fullscale = 2^bits - 1 - pedestal
noisy       = signal_dn + shot(signal_dn) + read + column_fpn   # only if --noise on
code        = clip(round(pedestal + noisy), 0, 2^bits - 1)
```

- Pedestal is added after noise; OB area gets pedestal + read noise only.
- ADC bit depth is applied per image (not by truncating a 12-bit image). Scale signal by 2^(bits-12).
- `--mechanism gain`: scale read noise with the gain; keep electrons constant.
- Writers:
  - **raw**: headerless uint16 LE, no padding, active area only. Name: see 6.
  - **bin**: Format A layout: `uint16 W, uint16 H` header with the **padded** size (e.g. 2080x1593), embedded-data row (deterministic non-image values, documented in the manifest), OB rows, active area, zero pad columns.
  - `--justify msb` shifts values left by `16 - bits` and applies to both layouts.
- Optional float32 `.npy` of the clean (pre-noise) frame in `truth/`.

## 6. Output layout and naming

```
out/<set>/
  color_hdr24dB_L_w2064_h1552_12b_RGGB_unpacked.raw
  color_hdr24dB_M_w2064_h1552_12b_RGGB_unpacked.raw      # if 3 frames
  color_hdr24dB_S_w2064_h1552_12b_RGGB_unpacked.raw
  mono_hdr24dB_L_w2064_h1552_12b_unpacked.raw            # mono: no pattern token
  *.bin                                                   # if --layout bin|both
  truth/radiance_f32.npy         # linear radiance, long full scale = 1.0
  truth/expected_hdr_f32.npy     # ideal merged output in long units
  manifest.json
```

`color` or `mono` is always the first token. The pattern token is omitted for mono (confirm with the user, see 9).

`manifest.json` must hold: tool version, all CLI args, per-frame gain (linear, dB, dB x cg split), pedestal per bit depth, justification, geometry (active/padded), seed, and a **patch table** (ID, rectangle, radiance per channel, expected valid frames per channel). It must also hold the **expected tool settings**: black level, per-frame gain dB, conversion ratio, and the thresholds the patches were built for.

## 7. Verification (the agent must build and run this)

`hdrgen verify <set>`:
1. Re-read every file with an independent reader and with the user's `decode_raw.py` / `hdr_merge.html` loader logic. Round-trip the pixel codes exactly.
2. Check pedestal in OB rows, zero padding, clipping counts (long must clip in the clipped-long region and nowhere in S), header sizes.
3. Noise-free sets: regress long against short in the linear range; the recovered gain must match the manifest within 0.01 dB.
4. Check bit-depth consistency: the same radiance gives codes scaling by 2^(bits-12) above the pedestal.

`hdrgen evaluate <set> <merged_output>` (compares a merge tool result to ground truth):
- Per-patch error in stops, split by channel.
- Colour cast: R/G and B/G ratio error on neutral patches.
- Seam metric: max step in the merged ramp across the blend zone.
- Clipped-region error and threshold-patch error.
- Pass/fail report with defaults (noise-free: under 0.02 stops everywhere except shadow; noisy: relative to the expected noise).

## 8. Presets (test matrix)

- `user_pair`: 2 frames, 6.4 dB, 12-bit, color, 2064x1552 (matches the real captures).
- `span24_2f` and `span24_3f`: 24 dB, 12-bit.
- `bits_matrix`: 8/10/12 x 2f/3f x color/mono at 24 dB.
- `gain_equivalence`: 6.4 dB x1.0, 0 dB x2.09, and 30 dB x2.6 (dB x ratio) sets, to check dB and conversion ratio combine correctly.
- `noisy`: `bits_matrix` with noise on.
- `binned`: 1032x776 GBRG.

## 9. Assumptions to confirm with the user

1. Mono filename has no pattern token (only `mono_` prefix).
2. "24 dB" means total span from long to short in amplitude dB (x15.85), with the mid frame at the geometric midpoint.
3. The real tool's thresholds and blend semantics (assumed as in section 2). If the slides define them differently, update `--thr-*` handling and the threshold patches.
4. Default justification is right-aligned (matches the real `.bin` and the user's `.raw`); `msb` is optional.

## 10. Work breakdown for the agent

0. **Recon**: read the user's `decode_raw.py`, the loader and parameter code in `hdr_merge.html`, and the real sample files, if available. Do not change them.
1. CLI skeleton, parameter validation, dB/gain/cg maths with unit tests.
2. Scene engine and patch table (resolution-independent; test at 64x64, 640x480, 2064x1552, 4096x3000).
3. Sensor model, bit-depth handling, noise.
4. Writers (`raw`, `bin`, justification) and manifest.
5. `verify` and `evaluate`.
6. Presets, README with examples and a worked example reproducing the real two-frame pair.
7. Self-check: run `bits_matrix`, run `verify`, run `evaluate` on the truth itself (must pass with zero error), and on a deliberately broken merge (for example gain 0 dB) (must fail).

## 11. Constraints

- Python 3, numpy only for the core; `tifffile` or `Pillow` optional for previews.
- Deterministic with `--seed`; process large images in row chunks.
- Plain, documented code; one module per concern (scene, sensor, writers, manifest, verify).
- No change to existing user files.

## 12. Acceptance criteria

- Noise-free set: ideal merge reproduces `expected_hdr` exactly (within 1 code).
- Files load in the user's `hdr_merge.html` and `decode_raw.py` without manual parameters.
- Same command and seed give byte-identical files.
- Any resolution works; colour output is always even-dimensioned.
- Broken merge settings (wrong gain, wrong black level, per-pixel switching) are detected by `evaluate`.
