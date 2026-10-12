"""Suggest CHDR viewer parameters from 2+ frames."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np

from hdr_suggest import load, pair

PAIR_NAMES_2 = ("long_short",)
PAIR_NAMES_3 = ("long_mid", "mid_short")


def analyse(
    paths: list[Path],
    black: Optional[float] = None,
    bits: int = 12,
    margin: float = 120,
    window: int = 300,
    exposures: Optional[list[float]] = None,
    cam_gain_db: Optional[list[float]] = None,
) -> dict:
    """Suggest viewer fields from frames ordered long (brightest) to short.

    Pipeline:
    1. Load each file. `.bin` also yields an optical-black mean; `.raw` does not.
    2. Black: `--black` if given, else the mean of those OB values. One field
       for every frame. `.raw` with no OB is an error, not an assumed 240.
    3. For each adjacent pair, measure Long/Short from 2x2 cell means
       (`pair.pair_gain`): global median on mid-tones, seam median near clip
       (that is the merge region). Composite dB is 20*log10(seam). Conversion
       gain is always 1 (same sensor mode).
    4. Thresholds sit just below clip so clipped Long pixels go to the shorter
       frame: High = floor((clip_eff-1-margin)/10)*10, Low = High-window.
       3F Mid-Short uses those values * Long-Mid ratio, rounded to 100
       (Long-scale composite).
    5. Blend 0.5 and tone 1 are fixed. Area % is how many pixels fall in
       long / blend / short under those thresholds.
    6. Warnings are non-fatal (OB spread, no clip, level-dependent gain, …).
    """
    if len(paths) < 2:
        raise ValueError("need at least 2 frames (long ... short)")
    if len(paths) > 3:
        raise ValueError("at most 3 frames supported")

    # --- load: active image + optional OB mean per file ---
    frames = [load.load_frame(p) for p in paths]
    clip = float(2**bits - 1)
    warnings: list[str] = []
    assumptions: list[str] = []

    # --- black: one pedestal for the viewer; never from image content ---
    ob_values = [b for _, b in frames if b is not None]
    black_source = "arg"
    if black is None:
        if not ob_values:
            raise ValueError("raw input: --black required (no OB rows in .raw)")
        black = float(np.mean(ob_values))
        black_source = "ob"
        if max(ob_values) - min(ob_values) > 1.5:
            warnings.append(
                f"OB mean differs between frames {[round(v, 1) for v in ob_values]}: "
                "viewer has ONE black field"
            )
    elif ob_values and max(ob_values) - min(ob_values) > 1.5:
        warnings.append(
            f"OB mean differs between frames {[round(v, 1) for v in ob_values]}: "
            "viewer has ONE black field"
        )

    black = float(black)
    clip_eff = clip - black
    _warn_order(frames, black, warnings)

    pair_names = PAIR_NAMES_3 if len(frames) == 3 else PAIR_NAMES_2
    g_lm: Optional[float] = None

    pairs_out: list[dict] = []
    for i, name in enumerate(pair_names):
        long_img, _ = frames[i]
        short_img, _ = frames[i + 1]

        # --- gain: median Long/Short on 2x2 cells (clipped cells dropped) ---
        r_glob, r_seam, curve, n_blocks = pair.pair_gain(
            long_img, short_img, black, clip
        )
        n_clip = int((long_img >= clip).sum())
        if n_clip == 0:
            warnings.append(
                f"{name}: Long not clipped (max {long_img.max() - black:.0f}); Short adds nothing"
            )

        if r_seam <= 0:
            raise ValueError(f"{name}: non-positive seam ratio")

        # Level curve vs seam: non-linearity or a 1 LSB black error in darks.
        dev = max(
            [abs(r / r_seam - 1) for lo, _hi, r, _c in curve if lo > 0.4 * clip_eff]
            or [0.0]
        )
        if dev > 0.05:
            warnings.append(
                f"{name}: ratio deviates {dev * 100:.0f}% from seam value above 0.4*clip "
                "(non-linearity/black error?)"
            )

        # --- thresholds: just below clip; narrow window so blend stays small ---
        high_mid = int((clip_eff - 1 - margin) // 10 * 10)
        low_mid = max(0, high_mid - window)
        high = high_mid
        low = low_mid
        unit = "longer-frame LSB"
        fallback_mid_units: Optional[list[int]] = None
        if name == "mid_short":
            if g_lm is None:
                raise ValueError("mid_short requires a preceding long_mid pair")
            # 3F viewer compares Mid-Short on Long-scale (Mid * G_LM).
            high = int(round(high_mid * g_lm / 100.0) * 100)
            low = int(round(low_mid * g_lm / 100.0) * 100)
            unit = "Long-scale"
            fallback_mid_units = [low_mid, high_mid]

        if high_mid / r_seam < 30:
            warnings.append(
                f"{name}: Short only {high_mid / r_seam:.0f} LSB at switch "
                f"(ratio {r_seam:.1f} too large)"
            )
        if r_seam < 1.5:
            warnings.append(f"{name}: frames nearly equal exposure")
        if abs(20 * np.log10(r_seam / r_glob)) > 0.5:
            warnings.append(
                f"{name}: gain varies with level "
                f"{20 * np.log10(r_glob):.2f} vs {20 * np.log10(r_seam):.2f} dB"
            )

        # --- zone fractions on the value the viewer actually compares ---
        if name == "mid_short" and g_lm is not None:
            v = (long_img - black) * g_lm
        else:
            v = long_img - black
        area_long = float((v < low).mean() * 100)
        area_blend = float(((v >= low) & (v < high)).mean() * 100)
        area_short = float((v >= high).mean() * 100)
        if area_short > 40:
            warnings.append(
                f"{name}: short fraction {area_short:.1f}% > 40% "
                "(Long exposure too long / thresholds too low)"
            )

        # Amplitude dB at the seam; conversion stays 1 so all ratio lives in dB.
        gain_db = float(20 * np.log10(r_seam))
        gain_db_global = float(20 * np.log10(r_glob))
        _warn_nominal(name, gain_db, i, exposures, cam_gain_db, warnings)

        if name == "long_mid":
            g_lm = r_seam

        pair_row = {
            "name": name,
            "gain_dB": round(gain_db, 2),
            "gain_dB_global": round(gain_db_global, 2),
            "ratio_seam": round(r_seam, 3),
            "ratio_global": round(r_glob, 3),
            "blocks_used": n_blocks,
            "conversion_gain_ratio": 1,
            "low": low,
            "high": high,
            "unit": unit,
            "blend": 0.5,
            "tone": 1,
            "area_pct": {
                "long": round(area_long, 1),
                "blend": round(area_blend, 1),
                "short": round(area_short, 1),
            },
            "short_noise_in_long_LSB": round(2.6 * r_seam, 1),
            "long_clipped_pct": round(n_clip / long_img.size * 100, 2),
        }
        if fallback_mid_units is not None:
            pair_row["fallback_mid_units"] = fallback_mid_units
        pairs_out.append(pair_row)

    result: dict = {
        "black": round(black, 1),
        "clip_after_black": round(clip_eff, 1),
        "black_source": black_source,
        "ob_means": [round(v, 1) for v in ob_values] if ob_values else None,
        "inputs": [str(p) for p in paths],
        "pairs": pairs_out,
        "assumptions": assumptions,
        "warnings": warnings,
    }
    if len(pairs_out) >= 2:
        result["chain_dB"] = round(
            pairs_out[0]["gain_dB"] + pairs_out[1]["gain_dB"],
            2,
        )
    return result


def _warn_order(
    frames: list[tuple[np.ndarray, Optional[float]]],
    black: float,
    warnings: list[str],
) -> None:
    """Warn if medians are not long -> short; still keep the given order."""
    medians = [float(np.median(img - black)) for img, _ in frames]
    if any(medians[i] < medians[i + 1] for i in range(len(medians) - 1)):
        warnings.append(
            f"median brightness order {[round(m, 1) for m in medians]} "
            "disagrees with given long->short order; analysing in given order"
        )


def _warn_nominal(
    name: str,
    gain_db: float,
    pair_index: int,
    exposures: Optional[list[float]],
    cam_gain_db: Optional[list[float]],
    warnings: list[str],
) -> None:
    """Typed exposure/camera-gain dB is a check only, never the suggested gain."""
    if exposures is None:
        return
    if pair_index + 1 >= len(exposures):
        return
    t_long = exposures[pair_index]
    t_short = exposures[pair_index + 1]
    if t_short <= 0 or t_long <= 0:
        return
    g_long = 0.0
    g_short = 0.0
    if cam_gain_db is not None and pair_index + 1 < len(cam_gain_db):
        g_long = cam_gain_db[pair_index]
        g_short = cam_gain_db[pair_index + 1]
    nominal = 20 * np.log10(t_long / t_short) + (g_long - g_short)
    if abs(gain_db - nominal) > 0.5:
        warnings.append(
            f"{name}: measured {gain_db:.2f} dB vs nominal {nominal:.2f} dB "
            "(flicker or camera-gain mismatch; gain valid only for this capture set)"
        )
