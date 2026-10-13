"""Human-readable report in CHDR panel order."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TextIO


def format_report(result: dict) -> str:
    """Return a panel-order explanation with measured numbers in each section."""
    lines: list[str] = []
    black = result["black"]
    clip_eff = result["clip_after_black"]
    source = result["black_source"]
    ob = result.get("ob_means")

    lines.append("=== 1. Black level ===")
    if source == "ob" and ob:
        lines.append(
            f"Suggest black = {black} LSB (mean of OB rows across frames: {ob}). "
            f"clip_eff = {clip_eff} LSB. Viewer has one black field for all frames."
        )
    elif source == "arg":
        lines.append(
            f"Suggest black = {black} LSB (from --black). clip_eff = {clip_eff} LSB."
        )
    else:
        lines.append(f"Suggest black = {black} LSB. clip_eff = {clip_eff} LSB.")
    lines.append("")

    lines.append("=== 2. Composite gain & conversion gain ===")
    for p in result["pairs"]:
        lines.append(
            f"{p['name']}: composite gain = {p['gain_dB']:.2f} dB "
            f"(seam ratio {p['ratio_seam']:.3f} from {p['blocks_used']} cells; "
            f"global {p['gain_dB_global']:.2f} dB / {p['ratio_global']:.3f}). "
            f"Conversion gain = {p['conversion_gain_ratio']} "
            f"{'(HCG/LCG split)' if p['conversion_gain_ratio'] != 1 else '(same conversion mode; all ratio in dB)'}. "
            f"Short noise in Long units ~ {p['short_noise_in_long_LSB']} LSB."
        )
    if "chain_dB" in result:
        lines.append(
            f"Chained long->short = {result['chain_dB']:.2f} dB (sum of pair gains)."
        )
    lines.append("")

    lines.append("=== 3. Thresholds ===")
    for p in result["pairs"]:
        area = p["area_pct"]
        unit = p.get("unit", "longer-frame LSB")
        extra = ""
        if p.get("fallback_mid_units"):
            fb = p["fallback_mid_units"]
            extra = f" (Mid-unit fallback {fb[0]}/{fb[1]})"
        lines.append(
            f"{p['name']}: Low = {p['low']}, High = {p['high']} "
            f"({unit} after black; High ~ clip_eff-1-margin{extra}). "
            f"Area: long {area['long']}%, blend {area['blend']}%, "
            f"short {area['short']}% "
            f"(Long clipped {p['long_clipped_pct']}%)."
        )
    lines.append("")

    lines.append("=== 4. Blend ratios ===")
    for p in result["pairs"]:
        lines.append(
            f"{p['name']}: blend = {p['blend']} "
            f"(alpha on the longer frame; blend zone {p['area_pct']['blend']}% of pixels)."
        )
    lines.append("")

    lines.append("=== 5. Tone mapping ===")
    tone = result["pairs"][0]["tone"] if result["pairs"] else 1
    lines.append(
        f"Suggest tone = {tone} for display (0 = linear for checks; "
        f"higher values lift darks). Display-only; curve unknown."
    )
    lines.append("")

    lines.append("=== 6. Picture select ===")
    if len(result["pairs"]) >= 2:
        lines.append(
            "Check Map (zone colours), then HDR3F composite for neutral bright "
            "patches and no checkerboard (gain error ~0.1-0.3 dB), then Long/Mid/Short "
            "only to confirm slot assignment."
        )
    else:
        lines.append(
            "Check Map (cyan=long, green=blend, red=short), then CHDR2F composite "
            "for neutral bright patches and no checkerboard (gain error ~0.1-0.3 dB), "
            "then Long/Short only to confirm slot assignment."
        )
    lines.append("")

    if result.get("assumptions"):
        lines.append("=== Assumptions ===")
        for a in result["assumptions"]:
            lines.append(f"- {a}")
        lines.append("")

    if result.get("warnings"):
        lines.append("=== Warnings ===")
        for w in result["warnings"]:
            lines.append(f"- {w}")
        lines.append("")

    return "\n".join(lines)


def write_json(result: dict, path: Path) -> None:
    path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


def print_report(result: dict, stream: TextIO | None = None) -> None:
    text = format_report(result)
    if stream is None:
        print(text)
    else:
        stream.write(text)
        if not text.endswith("\n"):
            stream.write("\n")
