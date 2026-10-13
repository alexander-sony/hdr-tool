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
    scale: float = 1.0,
) -> tuple[float, float, list[tuple[float, float, float, int]], int]:
    """Estimate Long/Short from 2x2 Bayer cell means.

    Clipped cells are dropped. r_glob is the median ratio on mid-tones
    (30*scale < C_long < 0.8*clip_eff). r_seam is the same median near clip
    (0.65–0.97 of clip_eff), where the merge actually happens; falls back
    to r_glob if fewer than 2000 cells. The level curve is 15 log bins from
    30*scale to clip_eff for the linearity warning in analyse().
    `scale` is 2^(bits-12), so the 12-bit floors 30 and 5 match the codes.
    """
    clip_eff = clip - black
    long_floor = 30.0 * scale
    short_floor = 5.0 * scale
    cl = load.blocks(long_img - black)
    cs = load.blocks(short_img - black)
    clipped = load.blocks((long_img >= clip).astype(np.float32)) > 0
    clipped |= load.blocks((short_img >= clip).astype(np.float32)) > 0

    ok = (
        ~clipped
        & (cl > long_floor)
        & (cs > short_floor)
        & (cl < 0.8 * clip_eff)
        & (cs < 0.8 * clip_eff)
    )
    if int(ok.sum()) == 0:
        raise ValueError("no overlapping valid cells for gain estimate")
    r_glob = float(np.median(cl[ok] / cs[ok]))

    ok2 = ~clipped & (cl > long_floor) & (cs > short_floor)
    edges = np.geomspace(long_floor, clip_eff, 16)
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
