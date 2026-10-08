"""
FriKode Network Utilities
Detects local Wi-Fi / LAN IP addresses and generates memorable session codes.
"""

import os
import random
import socket
import string
from typing import List, Dict, Optional


def get_local_ip_addresses() -> List[Dict[str, str]]:
    """
    Scans network interfaces and returns all reachable non-loopback IPv4 addresses.
    Returns a list of dicts: [{"ip": "192.168.1.105", "label": "Wi-Fi / LAN"}, ...]
    """
    ip_list = []
    seen = set()

    # Strategy 1: Outbound route lookup (finds the primary interface used for LAN traffic)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        # Does not actually transmit packets, just determines routing table choice
        s.connect(("10.255.255.255", 1))
        primary_ip = s.getsockname()[0]
        s.close()
        if primary_ip and not primary_ip.startswith("127.") and primary_ip not in seen:
            ip_list.append({
                "ip": primary_ip,
                "label": "Primary Wi-Fi / LAN",
                "is_primary": True
            })
            seen.add(primary_ip)
    except Exception:
        pass

    # Strategy 2: Hostname resolution lookup
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            ip = info[4][0]
            if ":" not in ip and not ip.startswith("127.") and ip not in seen:
                ip_list.append({
                    "ip": ip,
                    "label": "Local Network",
                    "is_primary": False
                })
                seen.add(ip)
    except Exception:
        pass

    # Strategy 3: Fallback if no network interface detected
    if not ip_list:
        ip_list.append({
            "ip": "127.0.0.1",
            "label": "Localhost (Offline / Loopback)",
            "is_primary": True
        })

    return ip_list


def get_primary_ip() -> str:
    """Returns the single most likely local network IPv4 address."""
    ips = get_local_ip_addresses()
    for item in ips:
        if item.get("is_primary"):
            return item["ip"]
    return ips[0]["ip"] if ips else "127.0.0.1"


def generate_session_code(length: int = 4) -> str:
    """
    Generates a human-friendly, high-contrast session code (e.g. FRI-8492).
    Avoids visually ambiguous characters (like 0, O, 1, I).
    """
    chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    code = "".join(random.choice(chars) for _ in range(length))
    return f"FRI-{code}"


def normalize_host_address(raw_input: str, default_port: int = 4000) -> str:
    """
    Normalizes a user-entered address into a clean URL or host:port string.
    Examples:
        '192.168.1.5' -> 'http://192.168.1.5:4000'
        '192.168.1.5:8080' -> 'http://192.168.1.5:8080'
        'http://192.168.1.5:4000/' -> 'http://192.168.1.5:4000'
    """
    cleaned = raw_input.strip()
    if not cleaned:
        return ""

    if cleaned.startswith("http://") or cleaned.startswith("https://"):
        return cleaned.rstrip("/")

    if ":" in cleaned:
        return f"http://{cleaned}"
    
    return f"http://{cleaned}:{default_port}"

