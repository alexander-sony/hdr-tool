"""Load AYA `.bin` and headerless `.raw` frames."""

from __future__ import annotations

import re
import struct
from pathlib import Path

import numpy as np

META_ROWS = 1
OB_ROWS = 40
PAD_COLS = 16


class LoadError(ValueError):
    """Input file cannot be loaded."""


def load_frame(path: Path) -> tuple[np.ndarray, float | None]:
    """Return (active image float32 [H,W], black_from_ob or None)."""
    suffix = path.suffix.lower()
    if suffix == ".bin":
        return _load_bin(path)
    if suffix == ".raw":
        return _load_raw(path)
    raise LoadError(f"unsupported file type: {path}")


def _load_bin(path: Path) -> tuple[np.ndarray, float]:
    data = path.read_bytes()
    if len(data) < 4:
        raise LoadError(f"bin too small: {path}")
    width, height = struct.unpack("<HH", data[:4])
    expected = 4 + width * height * 2
    if len(data) != expected:
        raise LoadError(f"not AYA bin (size {len(data)} != {expected}): {path}")
    array = np.frombuffer(data, dtype="<u2", offset=4).reshape(height, width)
    top = META_ROWS + OB_ROWS
    act_w = width - PAD_COLS
    if height <= top or act_w <= 0:
        raise LoadError(f"bin geometry too small for OB/pad: {path}")
    black = float(array[META_ROWS:top, :act_w].mean())
    active = array[top:, :act_w].astype(np.float32)
    return active, black


def _load_raw(path: Path) -> tuple[np.ndarray, float | None]:
    match = re.search(r"_w(\d+)_h(\d+)_(\d+)b", path.name)
    if match is None:
        raise LoadError(f"raw name must contain _w<W>_h<H>_<bits>b: {path.name}")
    width = int(match.group(1))
    height = int(match.group(2))
    expected = width * height * 2
    size = path.stat().st_size
    if size != expected:
        raise LoadError(f"raw size {size} != {expected}: {path}")
    image = np.fromfile(path, dtype="<u2").reshape(height, width).astype(np.float32)
    return image, None


def blocks(x: np.ndarray) -> np.ndarray:
    """2x2 Bayer cell mean (any phase contains R,G,G,B)."""
    height, width = x.shape
    h2 = height // 2 * 2
    w2 = width // 2 * 2
    return x[:h2, :w2].reshape(h2 // 2, 2, w2 // 2, 2).mean((1, 3))
