#!/usr/bin/env python3
"""
FriKode Entrypoint
Run this script to start FriKode and host or participate in a collaborative session.
"""

import argparse
import os
import sys

# Ensure frikode package is in path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from frikode.server import run_server


def main():
    parser = argparse.ArgumentParser(
        description="FriKode: Collaborative code editor for local network, cloud & anywhere."
    )
    parser.add_argument(
        "-w", "--workspace",
        default=os.environ.get("WORKSPACE_DIR", "sample_project"),
        help="Path to the project workspace directory (default: sample_project or $WORKSPACE_DIR)"
    )
    parser.add_argument(
        "-p", "--port",
        type=int,
        default=int(os.environ.get("PORT", 4000)),
        help="Port to run FriKode server on (default: 4000 or $PORT)"
    )
    parser.add_argument(
        "-H", "--host",
        default=os.environ.get("HOST", "0.0.0.0"),
        help="Host address to bind to (default: 0.0.0.0 or $HOST)"
    )
    parser.add_argument(
        "--public", "--tunnel",
        action="store_true",
        default=os.environ.get("ENABLE_TUNNEL", "").lower() in ("true", "1", "yes"),
        help="Enable public internet sharing via Cloudflare Tunnel (no shared Wi-Fi needed)"
    )
    parser.add_argument(
        "--public-url",
        default=os.environ.get("PUBLIC_URL"),
        help="Custom public URL if hosted on a cloud domain or reverse proxy"
    )

    args = parser.parse_args()

    # Create workspace if it does not exist
    workspace_path = os.path.abspath(args.workspace)
    if not os.path.exists(workspace_path):
        os.makedirs(workspace_path, exist_ok=True)

    run_server(
        workspace_path=workspace_path,
        host=args.host,
        port=args.port,
        public_tunnel=args.public,
        public_url=args.public_url
    )


if __name__ == "__main__":
    main()

