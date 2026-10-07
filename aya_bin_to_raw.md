# AYA IMX900 `.bin` → pixel-only `.raw`

Verified on IMX900 full-array captures: header 2080×1593 → active 2064×1552.

## `.bin` structure (all little-endian)

```
offset 0   uint16  W              # stored width  (2080)
offset 2   uint16  H              # stored height (1593)
offset 4   uint16[W*H]            # pixels, row-major, stride = W
                                  # 12-bit value right-aligned in 16-bit word (0..4095)
file size = 4 + W*H*2             # no footer
```

Frame layout inside the W×H grid:

```
row 0          embedded-data / metadata line   (NOT pixels)
rows 1..40     optical black (OB), mean ≈ 240  (black pedestal, NOT image)
rows 41..H-1   active image rows               (H-41 = 1552)
cols 0..W-17   active image cols               (W-16 = 2064)
cols W-16..W-1 zero padding                    (NOT pixels)
```

Bayer: RGGB, phase measured at active (0,0) = frame (row 41, col 0).
Pedestal 240 is left in the data (not subtracted).

## Pseudocode

```
const META_ROWS = 1
const OB_ROWS   = 40
const PAD_COLS  = 16

function bin_to_raw(bin_path, raw_path):
    buf = read_bytes(bin_path)
    W = u16_le(buf[0:2])
    H = u16_le(buf[2:4])
    assert len(buf) == 4 + W*H*2                 # else: wrong format, stop

    px = u16_le_array(buf[4:])  reshaped [H][W]  # row-major

    top      = META_ROWS + OB_ROWS               # 41
    act_w    = W - PAD_COLS                      # 2064
    act_h    = H - top                           # 1552
    act      = px[top : H][ : , 0 : act_w]       # drop header, meta row, OB rows, pad cols

    assert max(act) <= 4095                      # 12-bit right-aligned
    assert all(px[100:1500, act_w:W] == 0)       # pad cols are zero
    assert 200 < mean(px[1:41, 0:act_w]) < 280   # OB ≈ 240

    write_bytes(raw_path, act as u16 little-endian, row-major)   # no header
    # size must equal act_w * act_h * 2

    raw_name = f"{stem}_w{act_w}_h{act_h}_12b_RGGB_unpacked.raw"
```

## Output `.raw`

```
no header | uint16 LE | row-major | 2064×1552 | 12-bit right-aligned | RGGB | 6,406,656 bytes
```

## Python reference

```python
import numpy as np, struct
d = open(src, 'rb').read()
W, H = struct.unpack('<HH', d[:4])
assert len(d) == 4 + W*H*2
a = np.frombuffer(d, '<u2', offset=4).reshape(H, W)
a[41:, :W-16].astype('<u2').tofile(dst)
```

## If assertions fail

- Size ≠ 4+W·H·2 → different format (headerless or packed); do not guess.
- Different W×H (binned/ROI mode) → META/OB/PAD constants and Bayer phase are unverified; check OB row count by locating the jump from ≈240 to image level, and re-check phase (binned modes are GBRG per driver).
