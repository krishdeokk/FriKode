"""
FriKode Starter Demo
Try editing this function with your peers simultaneously!
"""

def calculate_mesh_latency(peer_count: int, ping_ms: float) -> dict:
    """Simulates network stats for local Wi-Fi peer mesh."""
    avg_rtt = ping_ms * 1.15
    status = "Optimal" if avg_rtt < 20 else "Nominal"
    return {
        "peers": peer_count,
        "rtt_ms": round(avg_rtt, 2),
        "status": status,
    }


if __name__ == "__main__":
    stats = calculate_mesh_latency(peer_count=4, ping_ms=3.5)
    print(f"[FriKode] Local Session Active: {stats}")
