"""Pairwise gain estimation from 2x2 cell means."""

from __future__ import annotations

import itertools

import numpy as np

from hdr_suggest import load


def pair_gain(
    long_img: np.ndarray,
    short_img: np.ndarray,
    black: float,
    clip: float,
) -> tuple[float, float, list[tuple[float, float, float, int]], int]:
    """Return (r_glob, r_seam, level_curve, blocks_used)."""
    clip_eff = clip - black
    cl = load.blocks(long_img - black)
    cs = load.blocks(short_img - black)
    clipped = load.blocks((long_img >= clip).astype(np.float32)) > 0
    clipped |= load.blocks((short_img >= clip).astype(np.float32)) > 0

    ok = ~clipped & (cl > 30) & (cs > 5) & (cl < 0.8 * clip_eff) & (cs < 0.8 * clip_eff)
    if int(ok.sum()) == 0:
        raise ValueError("no overlapping valid cells for gain estimate")
    r_glob = float(np.median(cl[ok] / cs[ok]))

    ok2 = ~clipped & (cl > 30) & (cs > 5)
    edges = np.geomspace(30, clip_eff, 16)
    curve: list[tuple[float, float, float, int]] = []
    for lo, hi in itertools.pairwise(edges):
        mask = ok2 & (cl >= lo) & (cl < hi)
        count = int(mask.sum())
        if count >= 500:
            curve.append(
                (float(lo), float(hi), float(np.median(cl[mask] / cs[mask])), count)
            )

    seam = ok2 & (cl > 0.65 * clip_eff) & (cl < 0.97 * clip_eff)
    if int(seam.sum()) >= 2000:
        r_seam = float(np.median(cl[seam] / cs[seam]))
    else:
        r_seam = r_glob
    return r_glob, r_seam, curve, int(ok.sum())
