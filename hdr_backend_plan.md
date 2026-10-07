# HDR backend plan (Sony HDR(2F)/(3F)Viewer or web equivalent)

Back-end spec: from 2+ IMX900 frames (`.bin` AYA or `.raw`), suggest **Black level, Gain (dB), Conversion gain, Low/High threshold, Blend, Tone**.
Frames are ordered **long (brightest) -> short**. Reference implementation: `hdr_params.py` (end of file). Verified on the FRAMOS IMX900 captures below.

## 1. Viewer model (what the parameters do)

```
Long  -> BlackSub(black) ---------------------------\
Short -> BlackSub(black) -> xGain -> CHDR synth ----> WB -> demosaic -> ToneMap(8b) -> display
                                                 \--> +black -> gamma(16b) -> result.bin
CHDR, per pixel, v = Long - black  (compare AFTER black subtraction):
  v <  Low           -> Long
  v >= High          -> Short*G           (observed: ceiling is High <= 3854 for clip 3855; viewer may use ">")
  Low <= v < High    -> a*Long + (1-a)*Short*G     a = Blend, constant (not a ramp)
G = 10^(gain_dB/20) * conversion_ratio          (fields multiply)
```
- One black field for both frames. Tone mapping is display-only (0 = linear, higher lifts darks); default 1.
- Single-frame Long/Short views are unreliable (clip ~255 LSB, ignore tone/gain). Short-only merge (Low=High=0) hides gain (output rescaled). Gain can only be judged at the seam.
- 3F (Long/Mid/Short) cascade and the (Mid-Short) 45000/50000 threshold scale are **unverified**; output pairwise values and flag.

## 2. Inputs

| source | pixels | black level |
|---|---|---|
| `.bin` (AYA) | see `aya_bin_to_raw.md`: u16 W,H then W*H u16; active = rows 41.., cols 0..W-17 | mean of OB rows 1..40, cols 0..W-17 (IMX900: ~240.0 +-0.6 per frame, 12-bit) |
| `.raw` | name `_w<W>_h<H>_<bits>b_<bayer>`; u16 LE, right-aligned; **no OB rows** | must be supplied (`--black`), or taken from the matching `.bin`; never guess from image (default for this kit: 240) |

Check: black differs between frames by >1.5 LSB -> warn (viewer has one field; gain/digital gain may shift pedestal).
`clip = 2^bits-1 = 4095`; `clip_eff = clip - black` (3855). Raw clip pile-up (`pixel==4095`) confirms it.

## 3. Algorithm

```
black    = given or mean(OB rows) over frames
cell(x)  = 2x2 mean (any Bayer phase; contains R,G,G,B)
C_f      = cell(frame_f - black)
K        = cell(frame_L>=clip)>0 OR cell(frame_S>=clip)>0        # any clipped px in cell
for each adjacent pair (L,S):
  valid  = ~K & 30 < C_L < 0.8*clip_eff & 5 < C_S < 0.8*clip_eff
  r_glob = median(C_L/C_S | valid)                                 # robust, not mean of all px
  r_seam = median(C_L/C_S | ~K, 0.65*clip_eff < C_L < 0.97*clip_eff)   # if >=2000 cells else r_glob
  gain_dB = 20*log10(r_seam)          # ratio where the merge happens (gain error shows as step there)
  conversion_ratio = 1                # all gain/exposure differences go in dB; ratio only if frames used different HG/LG modes (not inferable from image)
  High   = floor((clip_eff - 1 - margin)/10)*10      # margin 120 -> 3730 ; hard limit High <= clip_eff-1
  Low    = High - 300                                 # narrow window; wide window = constant 50/50 mix = more noise
  Blend  = 0.5 ; Tone = 1
  report area%: v<Low, Low<=v<High, v>=High on Long
  short_noise_in_long_LSB = sigma_short(~2.6) * r_seam
chain 3 frames: dB(L,S) = dB(L,M) + dB(M,S)  (Mid thresholds per pair; 3F semantics unverified)
```
NEVER use mean(all pixels) ratio (gives 2.8-4.4 where truth is ~7: clipped px + pedestal + noisy darks), and NEVER compute dB from typed exposures.

## 4. Warnings to emit
- Long not clipped (`max < clip_eff`): Short adds nothing.
- ratio < 1.5 (frames ~equal) or `High/ratio < 30` LSB (Short at switch too noisy; ratio >~16-20 impractical for 2 frames, use Mid).
- `|dB_seam - dB_glob| > 0.5` or per-level ratio deviates >5% above 0.4*clip_eff: gain level-dependent (black error ~1 LSB in dark Short, non-linearity, flicker).
- Short fraction > 40%: Long exposure too long / thresholds too low.
- Black differs between frames; black level changed -> High must move (`High < 4095 - black`).
- Gain is valid only for **that capture set**. Exposure is not proportional to typed value: lamp flicker (50 Hz mains = 100 Hz ripple) with exposures not a multiple of 10 ms changes brightness per capture (effective 1.2 ms measured as ~1.4, 2->2.33, 5->5.43, 10->10, 20->20.7). Recommend DC light or multiples of 10 ms. Camera gain must be identical across frames, else add the dB difference to gain_dB.

## 5. Output
```json
{"black":240.1,"clip_after_black":3854.9,
 "pairs":[{"gain_dB":16.73,"gain_dB_global":17.02,"ratio_seam":6.862,"conversion_gain_ratio":1,
           "low":3430,"high":3730,"blend":0.5,"tone":1,
           "area_pct":{"long":86.9,"blend":0.8,"short":12.4},"short_noise_in_long_LSB":17.8}],
 "warnings":[]}
```

## 6. Verification vectors (IMX900, 12-bit, 2064x1552, black ~240, clip_eff 3855, camera gain 0 dB, exposure in ms)

| pair (long / short) | ratio seam | dB seam | dB global |
|---|---|---|---|
| Mid10 / Short1.2 | 6.86 | 16.7 | 17.0 (7.09) |
| Long20 / Mid10 | - | 6.3 | 6.4 (x2.08) |
| Mid10 / Short1 | - | 19.9 | 20.1 (x10.1) |
| Short5 / Short1 | 5.06 | 14.1 | 15.0 (x5.48; warn level-dependent) |
Viewer settings that worked: Black 240, Gain 16.9, Conversion 1, Low 3000, High 3500, Blend 0.5, Tone 1. Pink/odd colours on clipped white card disappear when High <= 3854 (all clipped px go to Short).
OB mean per frame: Mid10 240.0, Short1.2 239.6, Short1 240.2, Short2 239.4.

## 7. Reference implementation (`hdr_params.py`)

```python
#!/usr/bin/env python3
"""Suggest Sony HDR(2F)Viewer parameters from 2+ frames (.bin AYA or .raw), ordered long -> short.
usage: hdr_params.py [--black N] [--bits 12] long.(bin|raw) [mid ...] short.(bin|raw)
"""
import numpy as np, struct, re, json, sys

def load(path):
    """-> (img float32 [H,W] pixels only, black_from_file or None)"""
    if path.endswith('.bin'):
        d = open(path, 'rb').read()
        W, H = struct.unpack('<HH', d[:4]); assert len(d) == 4 + W*H*2, 'not AYA bin'
        a = np.frombuffer(d, '<u2', offset=4).reshape(H, W)
        return a[41:, :W-16].astype(np.float32), float(a[1:41, :W-16].mean())  # OB rows 1..40
    m = re.search(r'_w(\d+)_h(\d+)_(\d+)b', path); assert m, 'raw name must contain _w<W>_h<H>_<bits>b'
    w, h = int(m[1]), int(m[2])
    return np.fromfile(path, '<u2').reshape(h, w).astype(np.float32), None

def blocks(x):                       # 2x2 Bayer cell mean (any phase contains R,G,G,B)
    h, w = x.shape; return x[:h//2*2, :w//2*2].reshape(h//2, 2, w//2, 2).mean((1, 3))

def pair_gain(L, S, black, clip):
    cl, cs = blocks(L-black), blocks(S-black)
    ce = clip - black
    K = blocks((L >= clip).astype(np.float32)) > 0
    K |= blocks((S >= clip).astype(np.float32)) > 0
    ok = ~K & (cl > 30) & (cs > 5) & (cl < 0.8*ce) & (cs < 0.8*ce)
    r_glob = float(np.median(cl[ok]/cs[ok]))
    # level curve: ratio vs Long level (log bins), needs >=500 blocks per bin
    ok2 = ~K & (cl > 30) & (cs > 5)
    edges = np.geomspace(30, ce, 16); curve = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = ok2 & (cl >= lo) & (cl < hi)
        if m.sum() >= 500: curve.append((lo, hi, float(np.median(cl[m]/cs[m])), int(m.sum())))
    m = ok2 & (cl > 0.65*ce) & (cl < 0.97*ce)
    r_seam = float(np.median(cl[m]/cs[m])) if m.sum() >= 2000 else r_glob
    return r_glob, r_seam, curve, ok.sum()

def analyse(paths, black=None, bits=12, margin=120, window=300):
    fr = [load(p) for p in paths]; clip = 2**bits - 1; warn = []
    bl = [b for _, b in fr if b is not None]
    if black is None:
        assert bl, 'raw input: --black required'
        black = float(np.mean(bl))
        if max(bl) - min(bl) > 1.5: warn.append(f'OB mean differs between frames {bl}: viewer has ONE black field')
    ce = clip - black; res = {'black': round(black, 1), 'clip_after_black': round(ce, 1), 'pairs': [], 'warnings': warn}
    for i in range(len(fr)-1):
        L, S = fr[i][0], fr[i+1][0]
        rg, rs, curve, n = pair_gain(L, S, black, clip)
        nclip = int((L >= clip).sum())
        if nclip == 0: warn.append(f'pair{i}: Long not clipped (max {L.max()-black:.0f}); Short adds nothing')
        # linearity check near the seam: ratio per level bin vs seam ratio (warn only)
        dev = max([abs(r/rs-1) for lo, hi, r, _ in curve if lo > 0.4*ce] or [0])
        if dev > 0.05: warn.append(f'pair{i}: ratio deviates {dev*100:.0f}% from seam value above 0.4*clip (non-linearity/black error?)')
        high = int((ce - 1 - margin) // 10 * 10); low = max(0, high - window)
        if high/rs < 30: warn.append(f'pair{i}: Short only {high/rs:.0f} LSB at switch (ratio {rs:.1f} too large)')
        if rs < 1.5: warn.append(f'pair{i}: frames nearly equal exposure')
        if abs(20*np.log10(rs/rg)) > 0.5: warn.append(f'pair{i}: gain varies with level {20*np.log10(rg):.2f} vs {20*np.log10(rs):.2f} dB')
        v = L - black
        res['pairs'].append({'gain_dB': round(float(20*np.log10(rs)), 2), 'gain_dB_global': round(float(20*np.log10(rg)), 2),
            'ratio_seam': round(rs, 3), 'ratio_global': round(rg, 3), 'blocks_used': int(n), 'conversion_gain_ratio': 1,
            'low': low, 'high': high, 'blend': 0.5, 'tone': 1,
            'area_pct': {'long': round(float((v < low).mean()*100), 1), 'blend': round(float(((v >= low) & (v < high)).mean()*100), 1),
                         'short': round(float((v >= high).mean()*100), 1)},
            'short_noise_in_long_LSB': round(2.6*rs, 1), 'long_clipped_pct': round(nclip/L.size*100, 2)})
    return res

if __name__ == '__main__':
    a = sys.argv[1:]; kw = {}
    while a and a[0].startswith('--'): kw[a[0][2:]] = float(a[1]); a = a[2:]
    print(json.dumps(analyse(a, black=kw.get('black'), bits=int(kw.get('bits', 12))), indent=1))
```
