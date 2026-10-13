"""Pure CHDR curve formulas for the explorer page and tests.

Viewer model (after black subtraction):
  G = 10^(gain_dB/20) * conversion
  v = Long
  v < Low  -> Long
  v >= High -> Short * G
  else     -> blend * Long + (1 - blend) * Short * G

Tone is display-only. Tone 0 is linear; higher values lift shadows.
The power curve here is an illustration, not Sony's internal mapper.
"""

from __future__ import annotations

import numpy as np

ArrayLike = float | np.ndarray


def gain_linear(gain_db: float, conversion: float = 1.0) -> float:
    """Applied composite gain G = 10^(gain_dB/20) * conversion."""
    return float(10.0 ** (gain_db / 20.0) * conversion)


def frame_codes(
    luminance: ArrayLike,
    true_ratio: float,
    applied_gain: float,
    clip_eff: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Long, short (pre-gain), and short*G codes vs scene luminance.

    Luminance is in long-frame LSB after black. Long has slope 1 and clips
    at clip_eff. Short has slope 1/true_ratio and clips at the same AD
    clip; multiplying by applied_gain stretches it toward synthetic bits.
    """
    if true_ratio <= 0:
        raise ValueError("true_ratio must be > 0")
    if applied_gain <= 0:
        raise ValueError("applied_gain must be > 0")
    if clip_eff <= 0:
        raise ValueError("clip_eff must be > 0")

    lum = np.asarray(luminance, dtype=np.float64)
    long_code = np.minimum(lum, clip_eff)
    short_code = np.minimum(lum / true_ratio, clip_eff)
    short_gained = short_code * applied_gain
    return long_code, short_code, short_gained


def composite(
    long_code: ArrayLike,
    short_gained: ArrayLike,
    low: float,
    high: float,
    blend: float,
) -> np.ndarray:
    """Stitch long and gained short using constant blend in [low, high)."""
    if high < low:
        raise ValueError("high must be >= low")
    if not 0.0 <= blend <= 1.0:
        raise ValueError("blend must be in [0, 1]")

    long_v = np.asarray(long_code, dtype=np.float64)
    short_v = np.asarray(short_gained, dtype=np.float64)
    if long_v.shape != short_v.shape:
        raise ValueError("long_code and short_gained must have the same shape")

    out = np.empty_like(long_v)
    use_long = long_v < low
    use_short = long_v >= high
    use_blend = ~(use_long | use_short)

    out[use_long] = long_v[use_long]
    out[use_short] = short_v[use_short]
    out[use_blend] = blend * long_v[use_blend] + (1.0 - blend) * short_v[use_blend]
    return out


def tone_8bit(
    values: ArrayLike,
    peak: float,
    tone: float,
) -> np.ndarray:
    """Map linear composite codes to 8-bit with optional shadow lift.

    tone 0: y = 255 * x
    tone > 0: y = 255 * x^(1/(1+0.45*tone))
    where x = clip(value / peak, 0, 1). Peak is the top of gained short.
    """
    if peak <= 0:
        raise ValueError("peak must be > 0")
    if tone < 0:
        raise ValueError("tone must be >= 0")

    x = np.clip(np.asarray(values, dtype=np.float64) / peak, 0.0, 1.0)
    if tone == 0:
        return 255.0 * x
    exponent = 1.0 / (1.0 + 0.45 * tone)
    return 255.0 * np.power(x, exponent)


def synthetic_peak(clip_eff: float, applied_gain: float) -> float:
    """Top of short*G when short reaches the AD clip."""
    return float(clip_eff * applied_gain)


def map_region_2f(long_code: float, low: float, high: float) -> str:
    """2F Map source: long / blend / short from long-frame code."""
    if long_code < low:
        return "long"
    if long_code >= high:
        return "short"
    return "blend"


def map_region_3f(
    long_code: float,
    mid_gained: float,
    low_lm: float,
    high_lm: float,
    low_ms: float,
    high_ms: float,
) -> str:
    """3F Map source after Long-Mid then Mid-Short on the Long-scale composite.

    Mid-Short Low/High are Long-scale (LM thresholds × G_LM). Long itself
    never reaches those values; Short is selected from gained Mid.
    """
    if long_code < low_lm:
        stage1 = "long"
        c1 = long_code
    elif long_code >= high_lm:
        stage1 = "mid"
        c1 = mid_gained
    else:
        stage1 = "lm_blend"
        c1 = long_code

    if c1 < low_ms:
        return stage1
    if c1 >= high_ms:
        return "short"
    return "ms_blend"


def composite_3f(
    long_code: ArrayLike,
    mid_gained: ArrayLike,
    short_gained: ArrayLike,
    low_lm: float,
    high_lm: float,
    blend_lm: float,
    low_ms: float,
    high_ms: float,
    blend_ms: float,
) -> np.ndarray:
    """Two-stage CHDR stitch: Long-Mid, then Mid-Short on Long-scale.

    3F slide (Function 5): β weights Mid in the LM window, α weights Short
    in the MS window. 2F instead puts α on Long. At 0.5 they agree.
    """
    first = composite(long_code, mid_gained, low_lm, high_lm, 1.0 - blend_lm)
    return composite(first, short_gained, low_ms, high_ms, 1.0 - blend_ms)


# Teaching stand-ins for mosaic channel imbalance at 12-bit (RGGB at 0,0).
_BAYER_R_12 = 8.0
_BAYER_GR_12 = 0.0
_BAYER_GB_12 = 0.0
_BAYER_B_12 = -8.0
_NOISE_SIGMA_12 = 2.6


def bit_scale(bits: int) -> float:
    """Native LSB per 12-bit LSB: 8-bit 1/16, 10-bit 1/4, 12-bit 1."""
    return float(2 ** (bits - 12))


def default_noise_sigma(bits: int) -> float:
    """Pedestal-noise figure used by hdr-suggest, in this frame's LSB."""
    return _NOISE_SIGMA_12 * bit_scale(bits)


def bayer_offsets(height: int, width: int, scale: float) -> np.ndarray:
    """RGGB channel offsets in native LSB (phase at pixel 0,0 = R)."""
    if height < 1 or width < 1:
        raise ValueError("height and width must be >= 1")
    if scale <= 0:
        raise ValueError("scale must be > 0")
    rows = np.arange(height)[:, None]
    cols = np.arange(width)[None, :]
    is_red = (rows % 2 == 0) & (cols % 2 == 0)
    is_gr = (rows % 2 == 0) & (cols % 2 == 1)
    is_gb = (rows % 2 == 1) & (cols % 2 == 0)
    out = np.empty((height, width), dtype=np.float64)
    out[is_red] = _BAYER_R_12 * scale
    out[is_gr] = _BAYER_GR_12 * scale
    out[is_gb] = _BAYER_GB_12 * scale
    out[~is_red & ~is_gr & ~is_gb] = _BAYER_B_12 * scale
    return out


def seam_scene_luminance(
    mean: float,
    height: int,
    width: int,
    scale: float,
    sigma: float,
    rng: np.random.Generator,
) -> np.ndarray:
    """Flat-patch scene in long LSB: mean + Bayer offsets + Gaussian noise.

    Used by the seam zoom so neighboring mosaic sites can straddle Low/High.
    """
    if sigma < 0:
        raise ValueError("sigma must be >= 0")
    scene = mean + bayer_offsets(height, width, scale)
    if sigma > 0:
        scene = scene + rng.normal(0.0, sigma, size=(height, width))
    return scene


def seam_long_codes(
    mean: float,
    height: int,
    width: int,
    scale: float,
    sigma: float,
    clip_eff: float,
    rng: np.random.Generator,
) -> np.ndarray:
    """Long codes for a blend-window patch (clipped scene luminance)."""
    if clip_eff <= 0:
        raise ValueError("clip_eff must be > 0")
    scene = seam_scene_luminance(mean, height, width, scale, sigma, rng)
    return np.clip(scene, 0.0, clip_eff)
