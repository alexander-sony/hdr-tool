# hdr-suggest

CLI that reads 2 or 3 `.bin` (from AYA) or `.raw` frames (long brightest first, then short) and prints suggested settings for the Sony CHDR(2F)/(3F) viewer: black level, composite gain (dB), conversion gain, low/high thresholds, blend, tone. Each section cites a measured number.

Algorithm, viewer model, and warnings: [`../hdr_backend_plan.md`](../hdr_backend_plan.md). AYA `.bin` layout: [`../aya_bin_to_raw.md`](../aya_bin_to_raw.md).

## Run

From the repo root (`uv sync` once):

```
uv run hdr-suggest LONG.bin [MID.bin] SHORT.bin
uv run hdr-suggest LONG.raw MID.raw SHORT.raw --black 240
```

`--black` is required for `.raw` unless a `.bin` in the same run supplies optical-black rows. Do not guess black from image content. Do not auto-sort frames.

Optional: `--bits`, `--margin`, `--window`, `--exposures`, `--cam-gain-db`, `--json out.json`. Typed exposures are not the gain; they only trigger a flicker warning.

## Example (`data/3f`)

**3F**
```
uv run hdr-suggest data/3f/long-13p2-9db.bin data/3f/mid-6p6-9db.bin data/3f/short-3p3-9db.bin
```

Typical suggestion: black 240, gains 5.96 dB / 5.97 dB, conversion 1 / 1, Long–Mid 3430/3730, Mid–Short 6800/7400 (Long-scale), blend 0.5, tone 1.

**2F** — same folder, skip mid:
```
uv run hdr-suggest data/3f/long-13p2-9db.bin data/3f/short-3p3-9db.bin
```

Viewer screenshots of the 3F settings: [`../data/3f/viewer/hdr-3f.png`](../data/3f/viewer/hdr-3f.png), [`../data/3f/viewer/map-3f.png`](../data/3f/viewer/map-3f.png).

## Layout

| module | role |
|---|---|
| `cli.py` | `hdr-suggest` entry point |
| `load.py` | AYA `.bin` / headerless `.raw` |
| `pair.py` | seam and global cell ratios |
| `suggest.py` | black, gain, thresholds, blend, tone, warnings |
| `report.py` | panel-order text and JSON |
