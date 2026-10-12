"""CLI entry point for hdr-suggest."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from hdr_suggest import report, suggest
from hdr_suggest.load import LoadError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hdr-suggest",
        description=(
            "Suggest CHDR(2F)/(3F) viewer parameters from 2 or 3 IMX900 "
            ".bin/.raw frames (ordered long -> short)."
        ),
    )
    parser.add_argument(
        "frames",
        nargs="+",
        type=Path,
        help="2 or 3 frames, long (brightest) first, short last",
    )
    parser.add_argument("--black", type=float, default=None, help="black level LSB")
    parser.add_argument(
        "--bits", type=int, default=12, help="ADC bit depth (default 12)"
    )
    parser.add_argument(
        "--margin", type=float, default=120, help="High threshold margin"
    )
    parser.add_argument("--window", type=int, default=300, help="Low = High - window")
    parser.add_argument(
        "--exposures",
        type=float,
        nargs="+",
        default=None,
        help="nominal exposures (ms) in file order",
    )
    parser.add_argument(
        "--cam-gain-db",
        type=float,
        nargs="+",
        default=None,
        dest="cam_gain_db",
        help="camera gain (dB) per frame in file order",
    )
    parser.add_argument("--json", type=Path, default=None, help="write JSON result")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not (2 <= len(args.frames) <= 3):
        parser.error("need 2 or 3 frame paths")
    if args.exposures is not None and len(args.exposures) != len(args.frames):
        parser.error("--exposures count must match number of frames")
    if args.cam_gain_db is not None and len(args.cam_gain_db) != len(args.frames):
        parser.error("--cam-gain-db count must match number of frames")

    try:
        result = suggest.analyse(
            args.frames,
            black=args.black,
            bits=args.bits,
            margin=args.margin,
            window=args.window,
            exposures=args.exposures,
            cam_gain_db=args.cam_gain_db,
        )
    except (LoadError, ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    report.print_report(result)
    if args.json is not None:
        report.write_json(result, args.json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
