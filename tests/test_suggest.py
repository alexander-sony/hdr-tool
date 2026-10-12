"""Tests for hdr_suggest."""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np
import pytest

from hdr_suggest import load, report, suggest
from hdr_suggest.cli import main

ROOT = Path(__file__).resolve().parents[1]
DATA_3F = ROOT / "data" / "3f"


def _write_raw(path: Path, image: np.ndarray, bits: int = 12) -> Path:
    height, width = image.shape
    out = path.with_name(f"{path.stem}_w{width}_h{height}_{bits}b_RGGB_unpacked.raw")
    image.astype("<u2").tofile(out)
    return out


def _write_bin(path: Path, active: np.ndarray, black: float = 240.0) -> Path:
    """Write a minimal AYA-like bin: meta + OB + active, 16 pad cols."""
    act_h, act_w = active.shape
    width = act_w + 16
    height = 1 + 40 + act_h
    frame = np.zeros((height, width), dtype=np.uint16)
    frame[1:41, :act_w] = round(black)
    frame[41:, :act_w] = active.astype(np.uint16)
    header = struct.pack("<HH", width, height)
    path.write_bytes(header + frame.tobytes())
    return path


def test_load_raw_and_blocks(tmp_path: Path) -> None:
    img = np.arange(16, dtype=np.uint16).reshape(4, 4)
    path = _write_raw(tmp_path / "frame", img)
    loaded, black = load.load_frame(path)
    assert black is None
    assert loaded.shape == (4, 4)
    cells = load.blocks(loaded.astype(np.float32))
    assert cells.shape == (2, 2)
    assert cells[0, 0] == pytest.approx((0 + 1 + 4 + 5) / 4)


def test_load_bin_ob(tmp_path: Path) -> None:
    active = np.full((4, 4), 1000, dtype=np.uint16)
    path = _write_bin(tmp_path / "frame.bin", active, black=241.0)
    loaded, black = load.load_frame(path)
    assert loaded.shape == (4, 4)
    assert black == pytest.approx(241.0)


def test_raw_requires_black(tmp_path: Path) -> None:
    long_img = np.full((32, 32), 2000, dtype=np.uint16)
    short_img = np.full((32, 32), 1000, dtype=np.uint16)
    p_long = _write_raw(tmp_path / "long", long_img)
    p_short = _write_raw(tmp_path / "short", short_img)
    with pytest.raises(ValueError, match="--black required"):
        suggest.analyse([p_long, p_short])


def test_pair_ratio_synthetic(tmp_path: Path) -> None:
    """Known ratio ~2 with no clipping in mid tones."""
    rng = np.random.default_rng(0)
    height, width = 128, 128
    black = 240.0
    signal = rng.uniform(200, 1500, size=(height, width))
    long_img = np.clip(np.round(black + signal), 0, 4095).astype(np.uint16)
    short_img = np.clip(np.round(black + signal / 2), 0, 4095).astype(np.uint16)
    # Force some clip on long so the "not clipped" warning stays off.
    long_img[0:4, 0:4] = 4095
    p_long = _write_raw(tmp_path / "long", long_img)
    p_short = _write_raw(tmp_path / "short", short_img)
    result = suggest.analyse([p_long, p_short], black=240)
    assert len(result["pairs"]) == 1
    pair = result["pairs"][0]
    assert pair["ratio_seam"] == pytest.approx(2.0, rel=0.05)
    assert pair["gain_dB"] == pytest.approx(6.02, abs=0.4)
    assert pair["conversion_gain_ratio"] == 1
    assert pair["low"] == 3430
    assert pair["high"] == 3730
    assert pair["blend"] == 0.5
    assert pair["tone"] == 1
    text = report.format_report(result)
    assert "Black level" in text
    assert "3430" in text
    assert str(pair["gain_dB"]) in text or f"{pair['gain_dB']:.2f}" in text


def test_order_warning(tmp_path: Path) -> None:
    bright = np.full((32, 32), 3000, dtype=np.uint16)
    dark = np.full((32, 32), 500, dtype=np.uint16)
    # Pass short then long (wrong order).
    p_short = _write_raw(tmp_path / "a", dark)
    p_long = _write_raw(tmp_path / "b", bright)
    result = suggest.analyse([p_short, p_long], black=240)
    assert any("disagrees" in w for w in result["warnings"])


def test_cli_json(tmp_path: Path) -> None:
    long_img = np.full((64, 64), 2000, dtype=np.uint16)
    long_img[0:2, 0:2] = 4095
    short_img = np.full((64, 64), 1000, dtype=np.uint16)
    p_long = _write_raw(tmp_path / "long", long_img)
    p_short = _write_raw(tmp_path / "short", short_img)
    out = tmp_path / "out.json"
    code = main([str(p_long), str(p_short), "--black", "240", "--json", str(out)])
    assert code == 0
    assert out.is_file()


@pytest.mark.skipif(not DATA_3F.exists(), reason="data/3f missing")
def test_data_3f_bins() -> None:
    paths = [
        DATA_3F / "long-13p2-9db.bin",
        DATA_3F / "mid-6p6-9db.bin",
        DATA_3F / "short-3p3-9db.bin",
    ]
    for p in paths:
        assert p.is_file(), p
    result = suggest.analyse(
        paths,
        exposures=[13.2, 6.6, 3.3],
        cam_gain_db=[9.0, 9.0, 9.0],
    )
    assert result["black"] == pytest.approx(239.8, abs=0.5)
    assert len(result["pairs"]) == 2
    lm, ms = result["pairs"]
    for pair in result["pairs"]:
        assert pair["gain_dB"] == pytest.approx(6.0, abs=0.15)
        assert pair["conversion_gain_ratio"] == 1
        assert pair["blend"] == 0.5
        assert pair["tone"] == 1
    assert lm["low"] == 3430
    assert lm["high"] == 3730
    assert ms["low"] == 6800
    assert ms["high"] == 7400
    assert ms["fallback_mid_units"] == [3430, 3730]
    assert result["chain_dB"] == pytest.approx(
        result["pairs"][0]["gain_dB"] + result["pairs"][1]["gain_dB"],
        abs=0.01,
    )
    assert any("OB mean differs" in w for w in result["warnings"])
    text = report.format_report(result)
    assert "6800" in text
    assert "7400" in text
    assert "long_mid" in text
    assert "mid_short" in text
    for section in (
        "Black level",
        "Composite gain",
        "Thresholds",
        "Blend ratios",
        "Tone mapping",
        "Picture select",
    ):
        assert section in text


@pytest.mark.skipif(not DATA_3F.exists(), reason="data/3f missing")
def test_data_3f_long_short_as_2f() -> None:
    """2F path: long + short from the 3F set (no separate data/2f)."""
    paths = [
        DATA_3F / "long-13p2-9db.bin",
        DATA_3F / "short-3p3-9db.bin",
    ]
    result = suggest.analyse(
        paths,
        exposures=[13.2, 3.3],
        cam_gain_db=[9.0, 9.0],
    )
    assert len(result["pairs"]) == 1
    pair = result["pairs"][0]
    assert pair["name"] == "long_short"
    assert pair["gain_dB"] == pytest.approx(11.95, abs=0.15)
    assert pair["low"] == 3430
    assert pair["high"] == 3730
    assert pair["long_clipped_pct"] > 1.0
    assert not any("Short adds nothing" in w for w in result["warnings"])
