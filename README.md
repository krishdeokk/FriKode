# FriKode

> **Local & Remote Collaborative Code Editor for Engineering Teams.**  
> Zero cloud databases. Zero accounts. Real-time CRDT synchronization. In-browser multi-language compiler. Built-in remote worldwide access across different Wi-Fi networks.

---

## 1. Product Overview

**FriKode** is a modern, independent pair programming and collaborative development environment engineered for hackathons, classrooms, remote teams, and study groups.

🌐 **Live Web Client on GitHub Pages:** [https://krishdeokk.github.io/FriKode/](https://krishdeokk.github.io/FriKode/)  
*Try the interactive demo workspace directly in your browser, or use it to join any active FriKode host remotely.*

FriKode supports two seamless ways to collaborate:
1. **Local Wi-Fi Mode**: Zero internet required. One laptop hosts directly from their local filesystem over the local Wi-Fi router with instantaneous `<2 ms` LAN latency.
2. **Worldwide Remote Mode**: Collaborate across different Wi-Fi networks, mobile cellular hotspots, or across continents. Built-in 1-click tunneling generates a secure public HTTPS link with zero password prompts, zero port forwarding, and zero account logins.

Participants join in any web browser with live collaborator carets, selection highlights, shared file explorer, conflict-free Yjs CRDT synchronization, and an **integrated in-browser multi-language compiler & execution terminal**.

---

## 2. Key Capabilities & Architecture

| Feature | Description | Architecture / Implementation |
| :--- | :--- | :--- |
| **Real-Time CRDT Sync** | Conflict-free simultaneous editing | Mathematical eventual consistency using **Yjs + `ypy-websocket` + `y-py`**. Peer keystrokes merge deterministically without collisions. |
| **Local Wi-Fi & LAN Speed** | Instant offline collaboration | Python `asyncio` + `aiohttp` server on port `4000`. Fast non-blocking UDP routing table discovery (`_probe_outbound_ip`) with 10s caching. |
| **Worldwide Remote Access** | Collaborate from different Wi-Fi networks | Built-in multi-provider tunnel architecture. Auto-generates isolated Ed25519 SSH keys (`~/.frikode_keys/`) with `BatchMode=yes` (zero password prompts via Pinggy), plus automatic Cloudflare tunnel fallback. |
| **In-Browser Compiler** | Run & compile code live in the browser | Server-side execution engine (`CodeRunner`) supporting Python (with live stdin), C/C++ (`gcc`/`clang`), Node.js, and Rust, with output streaming. |
| **Consistent Industrial Theme** | MailerBot-inspired design aesthetic | Porcelain (`#fffefc`) canvas, industrial warm sand borders (`#dad1c5`), high-contrast ink typography (`#050505`), and acid-lime (`#e9ffa3`) indicators. |
| **Multi-Tier Responsive Layout** | Scales smoothly across all window sizes | Fluid `clamp()` typography, `100dvh` units, off-canvas drawers for sidebar & activity, debounced CodeMirror auto-refresh, and short-height adaptations (`<= 650px`). |
| **Zero-Install for Peers** | Teammates join in 5 seconds | Peers simply open the host's Wi-Fi or Remote link in Chrome, Safari, Firefox, or Edge. No software install or repository clone required. |
| **Workspace Jail Security** | Protects the host's hard drive | Real filesystem path resolution (`os.path.realpath`) strictly blocks path traversal attacks (`../`) outside the shared directory. |

---

## 3. Quick Start & Launch Options

### Prerequisites
- Python 3.9 or higher (standard on macOS and Linux)
- A local Wi-Fi network, mobile hotspot, or active internet connection (if collaborating remotely)

### Option A: One-Command Launcher (macOS / Linux)
```bash
./run.sh
```
*Automatically sets up `.venv`, installs requirements, and launches FriKode on port `4000`.*

### Option B: Manual Setup
```bash
# 1. Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Start FriKode
python3 run.py
```

### Option C: Custom Port, Workspace, or Auto-Public Tunnel
```bash
# Host a specific project folder on port 5000:
python3 run.py --port 5000 --workspace my_project

# Launch with an immediate public tunnel link from the terminal:
python3 run.py --public
```

---

## 4. How Local Wi-Fi Collaboration Works

When developers are in the same room (classroom, hackathon table, coffee shop, or office):

```
                     ┌───────────────────────────────────────┐
                     │          Local Wi-Fi Router           │
                     └──────────────────┬────────────────────┘
                                        │
           ┌────────────────────────────┴────────────────────────────┐
           ▼                                                         ▼
┌─────────────────────────┐                               ┌─────────────────────────┐
│       Host Laptop       │                               │   Participant Laptop    │
│  (192.168.1.105:4000)   │◄─────────────────────────────►│  (192.168.1.112:4000)   │
│                         │        HTTP & WebSockets      │                         │
│ • Runs `python3 run.py` │         (Yjs CRDT Sync)       │ • Opens Chrome/Safari   │
│ • Files stay on disk    │                               │ • Zero install needed!  │
│ • Edits via browser UI  │                               │ • Edits via browser UI  │
└─────────────────────────┘                               └─────────────────────────┘
```

1. **Host starts the session**:
   - The host runs `python3 run.py` and opens `http://localhost:4000`.
   - The host terminal and UI immediately display the local Wi-Fi IP (e.g., `http://192.168.1.105:4000`) and 6-character session code (e.g., `FRI-HQAW`).
2. **Participants connect**:
   - Peers on the same Wi-Fi open `http://192.168.1.105:4000` in their browser.
   - Enter their display name and select a cursor color.
   - Click **Connect & Join**—the full IDE loads directly from the host laptop with zero downloads.

---

## 5. Working Remotely Across Different Wi-Fi Networks

When teammates are on **different Wi-Fi networks**, at home, or on cellular data, FriKode includes built-in remote access:

```
┌─────────────────────────┐                               ┌─────────────────────────┐
│     Host on Wi-Fi A     │                               │    Peer on Wi-Fi B      │
│  (Home / Office / Lab)  │                               │    (Home / Anywhere)    │
│                         │        Secure HTTPS / WSS     │                         │
│ • Runs FriKode locally  │◄─────────────────────────────►│ • Opens Remote Link:    │
│ • Clicks "Remote Access"│      Encrypted Public Tunnel  │   https://a.pinggy.link │
└─────────────────────────┘                               └─────────────────────────┘
```

### 1-Click Remote Access in the Web UI
1. In the FriKode workspace topbar, click the **Remote Access** pill button (or check **Enable Remote Access** in the Host modal).
2. FriKode activates an encrypted public HTTPS link (e.g. `https://xxxx.a.pinggy.link` or `https://xxxx.trycloudflare.com`).
3. Click the **Copy Remote Link** button and send it to your teammates.
4. Anyone in the world can open the link in their browser and start co-coding live on the host's files.

### Zero-Friction Tunnel Architecture
- **No Password Prompts**: FriKode auto-generates a secure, dedicated Ed25519 SSH keypair inside `~/.frikode_keys/` and runs with `BatchMode=yes`, ensuring SSH tunnels never prompt for passwords or block in the terminal.
- **Multi-Provider Fallback**: If the primary tunnel encounters rate limits, FriKode automatically switches to Cloudflare Tunnel (`cloudflared`).
- **No Port Forwarding or Router Configuration**: Works through NATs, firewalls, and university/campus networks.

### Cloud Container Deployment (Optional)
FriKode includes production-ready configuration for 24/7 cloud hosting:
- **`Dockerfile`**: Fully self-contained container bundle.
- **`render.yaml`**: 1-click deployment on Render's free tier.
- **Koyeb / Fly.io**: Deploy directly from your GitHub repository.

---

## 6. Built-in In-Browser Compiler & Console

FriKode includes an integrated execution terminal inside the workstation view so teams can run, test, and debug code collaboratively without leaving the browser:

```
┌────────────────────────────────────────────────────────────────────────┐
│ [● Ready] Console & Output                  [PYTHON] [Clear] [Max] [✕] │
├────────────────────────────────────────────────────────────────────────┤
│ >> Running /Users/krish/.../sample_project/main.py...                  │
│ [FriKode Local LAN Collaboration Demo]                                 │
│ Collaborative coding at local speed!                                   │
│                                                                        │
│ >> Process finished with exit code 0 (18ms)                            │
├────────────────────────────────────────────────────────────────────────┤
│ stdin > Enter input...                                     [Send Input]│
└────────────────────────────────────────────────────────────────────────┘
```

- **Keyboard Shortcut**: Press `Cmd/Ctrl + Enter` from anywhere in the editor to run the active file.
- **Multi-Language Support**:
  - **Python**: Direct subprocess execution with live streaming stdout and stderr.
  - **C / C++**: Automatic compilation via `clang` / `gcc` with sandboxed binary execution and clean compiler error output.
  - **JavaScript / Node.js**: Subprocess execution with error boundary capture.
  - **Rust**: Automated compilation via `rustc`.
- **Interactive Stdin**: Expand the stdin drawer to send runtime input directly to interactive programs (e.g., `input()` in Python or `scanf()` in C).
- **Execution Beacon**: Real-time status badge indicates `Ready` (slate), `Running` (pulsing acid-lime), `Success` (emerald), or `Error` (rose).

---

## 7. Responsive Scaling Across All Screens

FriKode's layout dynamically adapts to small browser windows, split-screen desktop snapping, tablets, and phones:

- **Desktop Snap & Medium Windows (`<= 1120px`)**:
  - Compact topbar with automatic IP/tunnel address truncation.
  - Compact icon badges for save, leave, and sync status.
  - Stats ribbon scales cleanly to 2x2 grid.
- **Tablets & Half-Screen Snap (`<= 920px`)**:
  - Landing navigation collapses into a responsive slide-down menu.
  - Activity & Peer drawer transitions to an off-canvas slide-out panel on the right.
- **Small Windows & Mobile (`<= 768px`)**:
  - Off-canvas file explorer drawer with backdrop blur and smooth cubic-bezier transitions.
  - Horizontal chip scroll row for session IP and remote access links.
  - Flexible editor and compiler heights (`min-height: 0; flex: 1`) preventing clipped status bars.
- **Short Browser Window Heights (`<= 650px`)**:
  - Compiler panel uses fluid `clamp(110px, 24vh, 160px)` so the editor and console share vertical space gracefully.
  - Modals and forms fit within `100dvh` with internal scrolling.
- **Live Resize Handler**:
  - Debounced `resize` listener automatically invokes `cm.refresh()` to ensure line numbers, carets, and code wrapping adapt instantaneously when window dimensions change.

---

## 8. Security & Trust Boundaries

> [!IMPORTANT]
> **Zero External Telemetry**: When running on local Wi-Fi, FriKode does not transmit your source code, keystrokes, or telemetry to any external cloud database.

- **Workspace File Jail**: Every read, write, rename, and delete operation undergoes canonical path resolution via `os.path.realpath`. Attempts to traverse outside the workspace (`../../etc/passwd` or `~/.ssh`) are blocked with HTTP 403 Forbidden.
- **Host Hard Drive Ownership**: The host computer owns all files on disk. Edits save directly to the host filesystem upon manual save (`Cmd/Ctrl+S`) or debounced auto-save.
- **Secure Key Isolation**: Auto-generated SSH keys for remote tunnels are restricted with `0600` permissions inside `.frikode_keys/` and ignored by `.gitignore`.

---

## 9. Automated Integration Test Suite

FriKode includes an automated test suite verifying network detection, workspace jail containment, code runner compilation/execution, and tunnel management:

```bash
source .venv/bin/activate
python3 -m unittest discover -s tests -v
```

All core unit tests run and pass in under 0.6 seconds:
- `TestFriKodeNetwork`: Non-blocking UDP route probing, normalization, session code generation.
- `TestCodeRunner`: Python execution, stdin input, runtime error handling, and C compilation.
- `TestFriKodeWorkspace`: File management, sample project generation, and path traversal jail defense.
- `TestTunnelManager`: Multi-provider tunnel lifecycle and availability checking.

---

## 10. License

FriKode is open-source software built for developers, students, and teams everywhere. Distributed under the MIT License.
