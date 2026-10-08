# FriKode

> **Local-network collaborative coding app for teams working together on the same Wi-Fi.**  
> Zero cloud. Zero user accounts. Real-time CRDT synchronization. 100% offline once installed.

---

## 1. Product Overview

**FriKode** is a modern, independent developer tool built for pair programming, hackathons, classrooms, and study groups on the same local Wi-Fi network. 

One laptop acts as the **Host**, serving the project workspace directly from their local filesystem. Other laptops on the same Wi-Fi network join the session using the host’s local network address or session code. Participants can open and edit files concurrently with live collaborator cursors, selection highlights, and deterministic conflict-free synchronization—without relying on cloud servers or an active internet connection.

---

## 2. Technology Stack & Rationale

| Component | Technology | Rationale |
| :--- | :--- | :--- |
| **Backend Runtime** | **Python 3 (`asyncio`)** | Standard on macOS, Linux, and developer environments. Fast, reliable, and requires zero Node/npm runtime overhead on the host machine. |
| **Server & Networking** | **`aiohttp`** | Unified asynchronous HTTP and WebSocket server. Serves static web assets, provides REST endpoints for file management, and handles real-time signaling over a single port (`4000`). |
| **CRDT Collaboration** | **Yjs + `ypy-websocket` + `y-py`** | Conflict-Free Replicated Data Type (CRDT) engine. Mathematical guarantee of eventual consistency: concurrent keystrokes from multiple peers merge deterministically with zero clobbered code and zero merge conflicts. |
| **Code Editor** | **CodeMirror** | High-performance, lightweight web editor with extensive syntax highlighting (Python, JavaScript, TypeScript, HTML, CSS, C/C++, Rust, Markdown, JSON), line numbering, bracket matching, and active-line highlighting. |
| **Remote Presence** | **`y-codemirror` + Yjs Awareness** | Renders real-time remote carets with floating collaborator names and colored text selections directly inside the editor view. |
| **Offline Vendoring** | **Self-contained static bundles** | All editor modes, addons, and CRDT scripts are vendored locally in `frikode/static/vendor/`. Once installed, FriKode runs with **zero internet access**. |
| **Security Layer** | **Workspace Jail & Canonical Path Guard** | Resolves real paths using `os.path.realpath` to strictly prevent directory traversal attacks (`../`) outside the chosen project directory. |

---

## 3. Quick Start & Run Commands

### Prerequisites
- Python 3.9 or higher (standard on macOS)
- A local Wi-Fi network or mobile hotspot shared between devices

### Option A: One-Command Launcher (macOS / Linux)
```bash
./run.sh
```
*This automatically creates a virtual environment `.venv`, installs requirements, and launches FriKode.*

### Option B: Manual Setup
1. **Create and activate a virtual environment:**
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```

2. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

3. **Start the FriKode server:**
   ```bash
   python3 run.py
   ```

4. **Customizing Port or Workspace:**
   ```bash
   # Custom port and folder:
   python3 run.py --port 5000 --workspace my_hackathon_project
   ```

---

## 4. How Hosting and Joining Works on the Same Wi-Fi

```
                     ┌───────────────────────────────────────┐
                     │          Local Wi-Fi Router           │
                     └──────────────────┬────────────────────┘
                                        │
           ┌────────────────────────────┴────────────────────────────┐
           ▼                                                         ▼
┌─────────────────────────┐                               ┌─────────────────────────┐
│     Host Laptop         │                               │   Participant Laptop    │
│  (10.70.150.209:4000)   │◄─────────────────────────────►│  (10.70.150.112:4000)   │
│                         │        HTTP & WebSockets      │                         │
│ • Runs `python3 run.py` │         (Yjs CRDT Sync)       │ • Opens Chrome/Safari   │
│ • Stores files on disk  │                               │ • No install required!  │
│ • Edits via browser UI  │                               │ • Edits via browser UI  │
└─────────────────────────┘                               └─────────────────────────┘
```

### For the Host
1. Connect to the local Wi-Fi network.
2. Run `./run.sh` or `python3 run.py`.
3. The terminal displays your local network address and session code:
   ```text
   ================================================================
     FriKode • Local Network Collaborative Code Editor
   ================================================================
     • Local Host:      http://localhost:4000
     • Wi-Fi Address:   http://10.70.150.209:4000
     • Session Code:    FRI-HQAW
     • Workspace:       /Users/krish/Documents/VS Code/Minor Project/sample_project
   ================================================================
   ```
4. Open `http://localhost:4000` in your browser and click **Enter Workspace**.
5. Keep your laptop awake while hosting.

### For the Participant
1. Connect to the **exact same Wi-Fi network** as the host.
2. Open any web browser (Chrome, Safari, Firefox, Edge).
3. In the URL bar, type the host’s Wi-Fi address (e.g. `http://10.70.150.209:4000`).
   - *Participants do not need to install Python or clone the repository! The entire app loads directly from the host laptop.*
4. Enter your name (e.g. "Sarah") and choose your cursor color.
5. Click **Connect & Join** to start collaborating in real time!

---

## 5. Main Features & Current Limitations

### Implemented Features
- **Deterministic CRDT Synchronization**: Real-time concurrent typing without overwriting teammate edits.
- **Remote Cursors & Selections**: Peer carets float above lines with the collaborator’s name and assigned accent color.
- **Collaborator Presence**:
  - Live avatar cluster in the top navigation bar.
  - Presence indicators in the file tree showing which collaborator is looking at which file.
  - Collapsible Activity feed showing who joined, left, or saved files.
- **Workspace File Management**:
  - Recursive file explorer (create files, create folders, rename, delete).
  - Multi-file tabs with dirty state indicators (`•`) and close buttons.
  - Safe file persistence directly to the host machine's disk.
  - Manual Save (`Cmd/Ctrl+S`) and debounced auto-save.
- **Local Network Discovery & Status**:
  - Automatic detection of local Wi-Fi IPv4 address.
  - Generated session code (`FRI-XXXX`) and one-click copy buttons.
  - Real-time Wi-Fi RTT latency monitor.
  - Reconnection banner when network connectivity drops.
  - Host session termination notice.
- **High-End Developer Tool UI**:
  - Dark Charcoal / Deep Navy foundation with electric-cyan and vivid-violet accents.
  - Distinctive `FriKode` wordmark.
  - Responsive layout optimized for laptops and tablets.

### Current Limitations
- **Local Network Scope**: Requires all machines to share the same subnet or router. Devices on isolated guest Wi-Fi networks (with AP client isolation enabled) cannot discover peer ports unless AP isolation is disabled.
- **Single Workspace Root**: FriKode shares one designated project folder at a time.
- **Host Process Dependency**: The host laptop must stay awake; if the host sleeps or closes their lid, active WebSocket connections pause until the host wakes up.

---

## 6. Security & Trust Boundaries

> [!IMPORTANT]
> **No Cloud Exposure**: FriKode does not transmit code, keystrokes, telemetry, or metadata to external third-party cloud services. All communication remains strictly on your local Wi-Fi subnet.

- **Workspace File Jail**: Every filesystem request undergoes canonical path resolution (`os.path.realpath`) against the workspace root. Any attempt to access files outside the workspace (such as `../../etc/passwd` or `~/.ssh`) is blocked with an HTTP 403 Forbidden error.
- **Local Network Trust Model**: FriKode is designed for trusted teammates working together in the same physical space. Traffic is transmitted over standard local HTTP/WS on the Wi-Fi network. Do not run FriKode with port forwarding exposed to the public internet without putting it behind a reverse proxy with TLS/SSL authentication.
- **Host Control**: The host machine owns the filesystem and has the authority to terminate the session, which safely disconnects all participants and saves the final file state on the host's disk.

---

## 7. Automated Test Suite

FriKode includes a full integration test suite verifying workspace jail containment, network utilities, REST API endpoints, and WebSocket signaling:

```bash
source .venv/bin/activate
python -m unittest tests/test_frikode.py
```
*(All 9 tests pass in under 0.1 seconds).*

