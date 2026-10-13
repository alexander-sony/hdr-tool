"""Tests for hdr_curves.model."""

from __future__ import annotations

import numpy as np
import pytest

from hdr_curves import model


def test_gain_linear_examples() -> None:
    assert model.gain_linear(6.02) == pytest.approx(2.0, rel=1e-3)
    assert model.gain_linear(0.0, 2.9) == pytest.approx(2.9)
    assert model.gain_linear(30.0, 2.6) == pytest.approx(82.215, rel=1e-3)


def test_matched_slopes_agree_at_midscale() -> None:
    g = model.gain_linear(6.02)
    clip_eff = 3855.0
    mid = 1000.0
    long_c, _, short_g = model.frame_codes(
        mid, true_ratio=g, applied_gain=g, clip_eff=clip_eff
    )
    assert long_c == pytest.approx(mid)
    assert short_g == pytest.approx(mid, rel=1e-3)


def test_composite_low_blend_high_regions() -> None:
    low, high, blend = 800.0, 1200.0, 0.5
    long_v = np.array([400.0, 1000.0, 2000.0])
    # Matched at mid: short_g == long; mismatch in blend to show mixing.
    short_g = np.array([400.0, 1400.0, 2000.0])
    out = model.composite(long_v, short_g, low, high, blend)
    assert out[0] == pytest.approx(400.0)
    assert out[1] == pytest.approx(0.5 * 1000.0 + 0.5 * 1400.0)
    assert out[2] == pytest.approx(2000.0)


def test_high_above_clip_never_selects_short() -> None:
    clip_eff = 3855.0
    low, high = 3430.0, 5000.0
    g = 2.0
    lum = np.linspace(0.0, clip_eff * g, 200)
    long_c, _, short_g = model.frame_codes(
        lum, true_ratio=g, applied_gain=g, clip_eff=clip_eff
    )
    out = model.composite(long_c, short_g, low, high, blend=0.5)
    assert high > clip_eff
    assert np.all(long_c < high)
    use_short = long_c >= high
    assert not np.any(use_short)
    # Matched gain below clip: composite equals long everywhere reachable.
    below_clip = lum <= clip_eff
    assert out[below_clip] == pytest.approx(long_c[below_clip])


def test_tone_linear_and_shadow_lift() -> None:
    peak = 3855.0 * 2.0
    values = np.array([0.0, peak * 0.1, peak])
    linear = model.tone_8bit(values, peak, tone=0)
    lifted = model.tone_8bit(values, peak, tone=4)
    assert linear[0] == pytest.approx(0.0)
    assert linear[-1] == pytest.approx(255.0)
    assert lifted[-1] == pytest.approx(255.0)
    assert lifted[1] > linear[1]
    # Monotone for both.
    dense = np.linspace(0.0, peak, 64)
    for t in (0, 4):
        y = model.tone_8bit(dense, peak, tone=t)
        assert np.all(np.diff(y) >= -1e-9)
        assert y[-1] == pytest.approx(255.0)
