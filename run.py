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
        description="FriKode: Local-network collaborative code editor for same Wi-Fi."
    )
    parser.add_argument(
        "-w", "--workspace",
        default="sample_project",
        help="Path to the project workspace directory (default: sample_project)"
    )
    parser.add_argument(
        "-p", "--port",
        type=int,
        default=4000,
        help="Port to run FriKode server on (default: 4000)"
    )
    parser.add_argument(
        "-H", "--host",
        default="0.0.0.0",
        help="Host address to bind to (default: 0.0.0.0 for LAN access)"
    )

    args = parser.parse_args()

    # Create workspace if it does not exist
    workspace_path = os.path.abspath(args.workspace)
    if not os.path.exists(workspace_path):
        os.makedirs(workspace_path, exist_ok=True)

    run_server(
        workspace_path=workspace_path,
        host=args.host,
        port=args.port
    )


if __name__ == "__main__":
    main()

