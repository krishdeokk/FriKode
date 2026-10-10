"""
FriKode Multi-Provider Public Tunnel Manager
Enables seamless remote collaboration over the public internet across different
Wi-Fi networks without port forwarding, router configuration, or manual software installation.

Supports:
  1. Cloudflare Quick Tunnel (if cloudflared binary is installed)
  2. Pinggy SSH Tunnel (uses pre-installed /usr/bin/ssh over port 443 - zero install needed)
  3. Localhost.run SSH Tunnel (uses pre-installed /usr/bin/ssh)
  4. Custom / Manual Public URL
"""

import logging
import os
import re
import shutil
import subprocess
import threading
import time
from typing import Optional, Dict, Any

logger = logging.getLogger("frikode.tunnel")

# URL extraction patterns
REGEX_CLOUDFLARE = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
REGEX_PINGGY = re.compile(r"https://[a-zA-Z0-9-]+\.(?:a\.|free\.)?pinggy\.link")
REGEX_LOCALHOST_RUN = re.compile(r"https://[a-zA-Z0-9-]+\.lhr\.life")
def _get_or_create_ssh_key() -> Optional[str]:
    """
    Returns the path to an SSH private key. If no SSH key exists on the user's
    machine (~/.ssh/), automatically generates a lightweight keypair in
    ~/.frikode/tunnel_key or .frikode_keys/tunnel_key so that SSH tunneling
    never prompts for an interactive password.
    """
    home = os.path.expanduser("~")
    ssh_dir = os.path.join(home, ".ssh")
    standard_keys = [
        os.path.join(ssh_dir, "id_ed25519"),
        os.path.join(ssh_dir, "id_rsa"),
        os.path.join(ssh_dir, "id_ecdsa"),
    ]
    for key_path in standard_keys:
        if os.path.isfile(key_path):
            return key_path

    # Check ~/.frikode/tunnel_key
    frikode_user_dir = os.path.join(home, ".frikode")
    frikode_user_key = os.path.join(frikode_user_dir, "tunnel_key")
    if os.path.isfile(frikode_user_key):
        return frikode_user_key

    # Check workspace-local .frikode_keys/tunnel_key
    local_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".frikode_keys"))
    local_key = os.path.join(local_dir, "tunnel_key")
    if os.path.isfile(local_key):
        return local_key

    # Generate an ed25519 key without passphrase
    ssh_keygen = shutil.which("ssh-keygen")
    if ssh_keygen:
        for target_dir, target_key in [(frikode_user_dir, frikode_user_key), (local_dir, local_key)]:
            try:
                os.makedirs(target_dir, exist_ok=True)
                subprocess.run(
                    [ssh_keygen, "-t", "ed25519", "-N", "", "-f", target_key, "-q"],
                    capture_output=True,
                    check=True,
                    timeout=5,
                )
                try:
                    os.chmod(target_key, 0o600)
                except Exception:
                    pass
                if os.path.isfile(target_key):
                    return target_key
            except Exception as e:
                logger.debug(f"Could not generate SSH key in {target_dir}: {e}")

    return None


class TunnelManager:
    """
    Unified manager for public remote tunnels in FriKode.
    """

    def __init__(self, port: int = 4000):
        self.port = port
        self.public_url: Optional[str] = None
        self.active_provider: Optional[str] = None
        self.error_message: Optional[str] = None
        self._process: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._monitor_thread: Optional[threading.Thread] = None

    @staticmethod
    def get_available_providers() -> Dict[str, bool]:
        """Returns availability of tunnel strategies on the current system."""
        has_cloudflared = shutil.which("cloudflared") is not None
        has_ssh = shutil.which("ssh") is not None
        return {
            "cloudflare": has_cloudflared,
            "pinggy": has_ssh,
            "localhost_run": has_ssh,
            "custom": True,
        }

    def start(self, provider: str = "auto", timeout: float = 18.0) -> Optional[str]:
        """
        Starts a public tunnel using the specified or best available provider.
        Provider options: 'auto', 'cloudflare', 'pinggy', 'localhost_run'.
        Returns public HTTPS URL if successful, or None.
        """
        with self._lock:
            # If already running with an active URL, return it
            if self.is_active() and self.public_url:
                return self.public_url

            self.stop()
            self.error_message = None

            chosen_provider = provider
            if provider == "auto":
                if shutil.which("cloudflared"):
                    chosen_provider = "cloudflare"
                elif shutil.which("ssh"):
                    chosen_provider = "pinggy"
                else:
                    self.error_message = "Neither cloudflared nor ssh found on system."
                    return None

            logger.info(f"Initiating FriKode Remote Tunnel using provider '{chosen_provider}' on port {self.port}...")

            # Attempt provider execution with fallback
            providers_to_try = [chosen_provider]
            if provider == "auto":
                if chosen_provider == "cloudflare" and shutil.which("ssh"):
                    providers_to_try.append("pinggy")
                if "pinggy" in providers_to_try and shutil.which("ssh"):
                    providers_to_try.append("localhost_run")

            url = None
            for p in providers_to_try:
                url = self._attempt_provider_start(p, timeout=timeout)
                if url:
                    self.public_url = url
                    self.active_provider = p
                    logger.info(f"Remote Tunnel successfully established via {p}: {url}")
                    return url

            if not url:
                self.error_message = f"Could not establish tunnel using {providers_to_try}. Check internet connection."
            return None

    def _attempt_provider_start(self, provider: str, timeout: float) -> Optional[str]:
        """Tries to launch a single tunnel provider and extract its public HTTPS URL."""
        cmd = []
        url_regex = None

        if provider == "cloudflare":
            cf_bin = shutil.which("cloudflared")
            if not cf_bin:
                return None
            cmd = [
                cf_bin,
                "tunnel",
                "--url", f"http://127.0.0.1:{self.port}",
                "--no-autoupdate",
            ]
            url_regex = REGEX_CLOUDFLARE

        elif provider == "pinggy":
            ssh_bin = shutil.which("ssh")
            if not ssh_bin:
                return None
            key_path = _get_or_create_ssh_key()
            # Pinggy over port 443 (HTTPS port) bypasses firewall blocks on port 22
            cmd = [
                ssh_bin,
                "-p", "443",
                "-R0:localhost:" + str(self.port),
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "ServerAliveInterval=30",
                "-o", "ServerAliveCountMax=3",
                "-o", "ConnectTimeout=10",
                "-o", "ExitOnForwardFailure=yes",
                "-o", "BatchMode=yes",
                "-T",
            ]
            if key_path:
                cmd.extend(["-i", key_path])
            cmd.append("a.pinggy.io")
            url_regex = REGEX_PINGGY

        elif provider == "localhost_run":
            ssh_bin = shutil.which("ssh")
            if not ssh_bin:
                return None
            key_path = _get_or_create_ssh_key()
            cmd = [
                ssh_bin,
                "-R", f"80:localhost:{self.port}",
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "ServerAliveInterval=30",
                "-o", "ServerAliveCountMax=3",
                "-o", "ConnectTimeout=10",
                "-o", "ExitOnForwardFailure=yes",
                "-o", "BatchMode=yes",
                "-T",
            ]
            if key_path:
                cmd.extend(["-i", key_path])
            cmd.append("nokey@localhost.run")
            url_regex = REGEX_LOCALHOST_RUN

        else:
            return None

        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            self._process = proc

            start_time = time.time()
            found_url = None

            while time.time() - start_time < timeout:
                if proc.poll() is not None:
                    logger.warning(f"Tunnel provider {provider} exited early with code {proc.returncode}")
                    break

                line = proc.stdout.readline()
                if not line:
                    time.sleep(0.1)
                    continue

                clean_line = line.strip()
                # Check specific regex
                match = url_regex.search(clean_line)
                if match:
                    found_url = match.group(0)
                    break

                # Secondary generic check if pinggy/localhost.run printed a banner
                if "pinggy" in provider and "https://" in clean_line:
                    gen_match = REGEX_GENERIC_HTTPS.search(clean_line)
                    if gen_match and "pinggy" in gen_match.group(0):
                        found_url = gen_match.group(0)
                        break

                if "localhost.run" in provider and "https://" in clean_line:
                    gen_match = REGEX_GENERIC_HTTPS.search(clean_line)
                    if gen_match and "lhr.life" in gen_match.group(0):
                        found_url = gen_match.group(0)
                        break

            if found_url:
                # Start background log consumer thread to keep pipes clear
                self._monitor_thread = threading.Thread(
                    target=self._drain_process_output,
                    args=(proc,),
                    daemon=True,
                )
                self._monitor_thread.start()
                return found_url

            # Failed on this provider
            proc.terminate()
            proc.wait(timeout=2)
            self._process = None
            return None

        except Exception as e:
            logger.error(f"Error launching tunnel provider {provider}: {e}")
            if self._process:
                try:
                    self._process.kill()
                except Exception:
                    pass
                self._process = None
            return None

    def _drain_process_output(self, proc: subprocess.Popen):
        """Continuously reads stdout to prevent buffer deadlock while the tunnel is active."""
        try:
            while proc.poll() is None:
                line = proc.stdout.readline()
                if not line:
                    break
        except Exception:
            pass

    def set_custom_url(self, url: str) -> str:
        """Sets a manual/custom public URL (e.g. from ngrok, Tailscale, or a VPS)."""
        with self._lock:
            self.stop()
            cleaned = url.strip().rstrip("/")
            if not cleaned.startswith("http://") and not cleaned.startswith("https://"):
                cleaned = f"https://{cleaned}"
            self.public_url = cleaned
            self.active_provider = "custom"
            self.error_message = None
            return self.public_url

    def stop(self):
        """Terminates any active tunnel process."""
        if self._process:
            try:
                self._process.terminate()
                self._process.wait(timeout=2)
            except Exception:
                try:
                    self._process.kill()
                except Exception:
                    pass
            self._process = None

        self.public_url = None
        self.active_provider = None

    def is_active(self) -> bool:
        """Returns True if a tunnel is currently open and healthy."""
        if self.active_provider == "custom":
            return bool(self.public_url)
        return self._process is not None and self._process.poll() is None and bool(self.public_url)

    def get_status(self) -> Dict[str, Any]:
        """Returns detailed tunnel status information."""
        active = self.is_active()
        return {
            "active": active,
            "url": self.public_url if active else None,
            "provider": self.active_provider if active else None,
            "available_providers": self.get_available_providers(),
            "port": self.port,
            "error": self.error_message,
        }


# Global singleton instance for easy import and sharing across server handlers
_global_tunnel_manager: Optional[TunnelManager] = None


def get_tunnel_manager(port: int = 4000) -> TunnelManager:
    """Returns or initializes the singleton TunnelManager instance."""
    global _global_tunnel_manager
    if _global_tunnel_manager is None or _global_tunnel_manager.port != port:
        _global_tunnel_manager = TunnelManager(port=port)
    return _global_tunnel_manager


class CloudflareTunnel(TunnelManager):
    """Backward-compatible wrapper for Cloudflare tunnel."""

    def __init__(self, port: int = 4000):
        super().__init__(port=port)

    @staticmethod
    def is_available() -> bool:
        return shutil.which("cloudflared") is not None

