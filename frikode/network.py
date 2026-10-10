"""
FriKode Network Utilities
Detects local Wi-Fi / LAN IP addresses and generates memorable session codes.
"""

import os
import random
import socket
import string
import time
from typing import List, Dict, Optional

# In-memory cache for detected network interfaces to ensure instant responses
_IP_CACHE = {
    "timestamp": 0.0,
    "ips": []
}
_CACHE_TTL = 10.0  # seconds


def _probe_outbound_ip(host: str, port: int) -> Optional[str]:
    """Safely and instantaneously determines the outbound routing IP using UDP."""
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.3)
        # Does not actually transmit packets, just inspects the kernel routing table
        s.connect((host, port))
        ip = s.getsockname()[0]
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass
    finally:
        if s:
            try:
                s.close()
            except Exception:
                pass
    return None


def get_local_ip_addresses() -> List[Dict[str, str]]:
    """
    Scans network interfaces and returns reachable non-loopback IPv4 addresses.
    Returns a list of dicts: [{"ip": "192.168.1.105", "label": "Wi-Fi / LAN"}, ...]
    """
    now = time.time()
    if _IP_CACHE["ips"] and (now - _IP_CACHE["timestamp"] < _CACHE_TTL):
        return list(_IP_CACHE["ips"])

    ip_list = []
    seen = set()

    # Strategy 1: Fast outbound route lookup across standard gateways / subnets
    probe_targets = [
        ("8.8.8.8", 80),
        ("1.1.1.1", 80),
        ("192.168.1.1", 1),
        ("10.255.255.255", 1),
        ("172.16.255.255", 1)
    ]
    for target_host, target_port in probe_targets:
        primary_ip = _probe_outbound_ip(target_host, target_port)
        if primary_ip and primary_ip not in seen:
            ip_list.append({
                "ip": primary_ip,
                "label": "Primary Wi-Fi / LAN",
                "is_primary": True
            })
            seen.add(primary_ip)
            break  # Found primary outbound interface

    # Strategy 2: Fast hostname lookup fallback if UDP route probe was blocked or offline
    if not ip_list:
        try:
            hostname = socket.gethostname()
            # Fast gethostbyname (doesn't trigger slow multithreaded getaddrinfo query)
            host_ip = socket.gethostbyname(hostname)
            if host_ip and not host_ip.startswith("127.") and host_ip not in seen:
                ip_list.append({
                    "ip": host_ip,
                    "label": "Local Network",
                    "is_primary": True
                })
                seen.add(host_ip)
        except Exception:
            pass

    # Strategy 3: Fallback if no network interface detected or fully offline
    if not ip_list:
        ip_list.append({
            "ip": "127.0.0.1",
            "label": "Localhost (Offline / Loopback)",
            "is_primary": True
        })

    _IP_CACHE["timestamp"] = now
    _IP_CACHE["ips"] = list(ip_list)
    return ip_list


def get_primary_ip(ips: Optional[List[Dict[str, str]]] = None) -> str:
    """Returns the single most likely local network IPv4 address."""
    if ips is None:
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

