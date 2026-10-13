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
