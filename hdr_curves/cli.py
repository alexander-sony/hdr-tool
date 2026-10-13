"""Serve the HDR curve explorer on a local port."""

from __future__ import annotations

import argparse
import functools
import http.server
import socketserver
from pathlib import Path
from typing import Optional

STATIC_DIR = Path(__file__).resolve().parent / "static"
DEFAULT_PORT = 10000


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hdr-curves",
        description=(
            "Serve an interactive page that shows how composite gain, "
            "thresholds, blend, and tone move the CHDR curves."
        ),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"HTTP port (default {DEFAULT_PORT})",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if not STATIC_DIR.is_dir():
        raise SystemExit(f"static folder missing: {STATIC_DIR}")

    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler,
        directory=str(STATIC_DIR),
    )
    # Allow quick restart after Ctrl+C on Windows.
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
        url = f"http://127.0.0.1:{args.port}/"
        print(f"HDR curve explorer: {url}")
        print("Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
