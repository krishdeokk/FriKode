"""
FriKode Public Tunnel Manager
Enables remote collaboration over the public internet without port forwarding
or shared Wi-Fi using Cloudflare Quick Tunnels.
"""

import asyncio
import logging
import os
import re
import shutil
import subprocess
import sys
from typing import Optional

logger = logging.getLogger("frikode.tunnel")

CLOUDFLARE_REGEX = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")


class CloudflareTunnel:
    """Manages a cloudflared quick tunnel subprocess to expose the local server."""

    def __init__(self, port: int = 4000):
        self.port = port
        self.public_url: Optional[str] = None
        self._process: Optional[subprocess.Popen] = None

    @staticmethod
    def is_available() -> bool:
        """Checks if cloudflared is installed on the system."""
        return shutil.which("cloudflared") is not None

    def start(self, timeout: float = 15.0) -> Optional[str]:
        """
        Starts cloudflared quick tunnel and extracts the generated https://*.trycloudflare.com URL.
        Returns the public URL if successful, or None.
        """
        cloudflared_bin = shutil.which("cloudflared")
        if not cloudflared_bin:
            logger.warning(
                "cloudflared is not installed. To enable free public tunnels, install it with:\n"
                "  • macOS: brew install cloudflared\n"
                "  • Linux: sudo apt install cloudflared\n"
                "  • Windows: winget install Cloudflare.cloudflared"
            )
            return None

        cmd = [
            cloudflared_bin,
            "tunnel",
            "--url", f"http://127.0.0.1:{self.port}",
            "--no-autoupdate",
        ]

        logger.info(f"Starting Cloudflare Quick Tunnel on port {self.port}...")

        try:
            self._process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )

            import time
            start_time = time.time()

            while time.time() - start_time < timeout:
                if self._process.poll() is not None:
                    logger.error("cloudflared tunnel process exited unexpectedly.")
                    break

                line = self._process.stdout.readline()
                if not line:
                    continue

                match = CLOUDFLARE_REGEX.search(line)
                if match:
                    self.public_url = match.group(0)
                    logger.info(f"Cloudflare Tunnel online: {self.public_url}")
                    return self.public_url

            logger.warning("Timed out waiting for Cloudflare Tunnel URL.")
            return None

        except Exception as e:
            logger.error(f"Failed to start cloudflared tunnel: {e}")
            return None

    def stop(self):
        """Stops the active tunnel subprocess."""
        if self._process and self._process.poll() is None:
            logger.info("Stopping Cloudflare tunnel...")
            self._process.terminate()
            try:
                self._process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._process.kill()
            self._process = None
            self.public_url = None

