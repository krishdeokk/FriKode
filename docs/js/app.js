/**
 * FriKode Application Controller
 * Handles view switching, session management, file tree, signaling, and presence.
 */

import * as Y from "../vendor/yjs.bundle.mjs";
import { WebsocketProvider } from "../vendor/y-websocket.bundle.mjs";
import { api } from "./api.js";
import { EditorManager } from "./editor.js";
import { Icons, getFileIcon } from "./icons.js";
import { ACCENT_COLORS, getRandomColor, copyToClipboard, showToast, formatTime, safeGetStorage, safeSetStorage } from "./utils.js";

/**
 * Zero-dependency pure JavaScript client-side ZIP generator (PKZIP standard).
 * Universally supported by macOS Archive Utility, Windows Explorer, Linux unzip, and mobile OSes.
 */
function createZipArchive(files) {
  const textEncoder = new TextEncoder();
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  const calcCrc = (bytes) => {
    let crc = 0 ^ (-1);
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ (-1)) >>> 0;
  };

  const fileEntries = [];
  let offset = 0;

  for (const f of files) {
    if (!f || !f.path) continue;
    const cleanPath = f.path.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    const nameBytes = textEncoder.encode(cleanPath);
    const content = typeof f.content === "string" ? f.content : (f.content || "");
    const dataBytes = textEncoder.encode(content);
    const crc = calcCrc(dataBytes);
    const size = dataBytes.length;

    // Fixed DOS time/date (Jan 1 2026, 12:00:00)
    const dosTime = (12 << 11) | (0 << 5) | 0;
    const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

    // Local file header (30 bytes + name length)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local header signature
    lv.setUint16(4, 20, true);         // Version needed: 2.0
    lv.setUint16(6, 0x0800, true);     // General purpose bit flag: UTF-8
    lv.setUint16(8, 0, true);          // Compression method: 0 (stored)
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);      // Compressed size
    lv.setUint32(22, size, true);      // Uncompressed size
    lv.setUint16(26, nameBytes.length, true); // Name length
    lv.setUint16(28, 0, true);         // Extra field length
    localHeader.set(nameBytes, 30);

    fileEntries.push({
      nameBytes,
      dataBytes,
      localHeader,
      offset,
      crc,
      size,
      dosTime,
      dosDate
    });

    offset += localHeader.length + dataBytes.length;
  }

  // Central directory
  const cdOffset = offset;
  const cdHeaders = [];
  let cdSize = 0;

  for (const entry of fileEntries) {
    const cdHeader = new Uint8Array(46 + entry.nameBytes.length);
    const cv = new DataView(cdHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central directory header signature
    cv.setUint16(4, 20, true);         // Version made by: 2.0
    cv.setUint16(6, 20, true);         // Version needed: 2.0
    cv.setUint16(8, 0x0800, true);     // Flags: UTF-8
    cv.setUint16(10, 0, true);         // Compression: stored
    cv.setUint16(12, entry.dosTime, true);
    cv.setUint16(14, entry.dosDate, true);
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, entry.size, true);
    cv.setUint32(24, entry.size, true);
    cv.setUint16(28, entry.nameBytes.length, true);
    cv.setUint16(30, 0, true);         // Extra field length
    cv.setUint16(32, 0, true);         // Comment length
    cv.setUint16(34, 0, true);         // Disk start
    cv.setUint16(36, 0, true);         // Internal attributes
    cv.setUint32(38, 0, true);         // External attributes
    cv.setUint32(42, entry.offset, true); // Relative offset of local header
    cdHeader.set(entry.nameBytes, 46);

    cdHeaders.push(cdHeader);
    cdSize += cdHeader.length;
  }

  // End of Central Directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);   // EOCD signature
  ev.setUint16(4, 0, true);            // Disk number
  ev.setUint16(6, 0, true);            // Disk start
  ev.setUint16(8, fileEntries.length, true);  // Records on disk
  ev.setUint16(10, fileEntries.length, true); // Total records
  ev.setUint32(12, cdSize, true);             // Size of CD
  ev.setUint32(16, cdOffset, true);           // Offset of start of CD
  ev.setUint16(20, 0, true);                  // Comment length

  const totalLength = cdOffset + cdSize + 22;
  const out = new Uint8Array(totalLength);
  let cursor = 0;
  for (const entry of fileEntries) {
    out.set(entry.localHeader, cursor);
    cursor += entry.localHeader.length;
    out.set(entry.dataBytes, cursor);
    cursor += entry.dataBytes.length;
  }
  for (const cdh of cdHeaders) {
    out.set(cdh, cursor);
    cursor += cdh.length;
  }
  out.set(eocd, cursor);

  return out;
}

/**
 * In-Browser Workspace Store
 * Enables every user on the website to create, save, switch, and export workspaces.
 */
class WorkspaceStore {
  constructor() {
    this.STORAGE_KEY = "frikode_workspaces_v2";
    this.ACTIVE_ID_KEY = "frikode_active_ws_id";
  }

  getAll() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  saveAll(workspaces) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(workspaces));
    } catch (e) {
      console.warn("[WorkspaceStore] Save failed:", e);
    }
  }

  getActiveId() {
    return localStorage.getItem(this.ACTIVE_ID_KEY);
  }

  setActiveId(id) {
    if (id) {
      localStorage.setItem(this.ACTIVE_ID_KEY, id);
    } else {
      localStorage.removeItem(this.ACTIVE_ID_KEY);
    }
  }

  getActiveWorkspace() {
    const all = this.getAll();
    const id = this.getActiveId();
    if (id && all[id]) return all[id];
    const keys = Object.keys(all);
    if (keys.length > 0) {
      this.setActiveId(keys[0]);
      return all[keys[0]];
    }
    return null;
  }

  saveWorkspace(ws) {
    if (!ws || !ws.id) return;
    const all = this.getAll();
    ws.last_active = Date.now();
    all[ws.id] = ws;
    this.saveAll(all);
  }

  getWorkspaceByCode(code) {
    if (!code) return null;
    const clean = code.toUpperCase().replace(/^FRI-/, "");
    const all = this.getAll();
    for (const ws of Object.values(all)) {
      if (ws.session_code && ws.session_code.toUpperCase().replace(/^FRI-/, "") === clean) {
        return ws;
      }
    }
    return null;
  }

  createWorkspace(name, template = "python", customSessionCode = null, customFiles = null) {
    const all = this.getAll();
    const id = "ws_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 6);
    const sessionCode = customSessionCode || ("FRI-" + Math.random().toString(36).substring(2, 6).toUpperCase());
    name = (name || "").trim() || "My Workspace";

    let files = {};
    if (customFiles && typeof customFiles === "object" && Object.keys(customFiles).length > 0) {
      files = { ...customFiles };
    } else if (template === "python") {
      files["main.py"] = {
        path: "main.py",
        name: "main.py",
        is_dir: false,
        size: 320,
        content: `# FriKode • Python Workspace\n# Real-time pair programming & compiler console\n\ndef greet(name):\n    return f"Welcome to {name}!"\n\ndef main():\n    msg = greet("${name}")\n    print(msg)\n    print("1. Edit any code in the editor.")\n    print("2. Press Cmd/Ctrl + Enter to run.")\n    print("3. Click 'Share / Invite' above to pair program.")\n\nif __name__ == "__main__":\n    main()\n`
      };
      files["README.md"] = {
        path: "README.md",
        name: "README.md",
        is_dir: false,
        size: 240,
        content: `# ${name}\n\nCollaborative Python workspace created in FriKode.\n\n- Real-time CRDT peer collaboration.\n- In-browser compiler & execution sandbox.\n`
      };
    } else if (template === "web") {
      files["index.html"] = {
        path: "index.html",
        name: "index.html",
        is_dir: false,
        size: 420,
        content: `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>${name}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main class="hero">\n    <h1>${name}</h1>\n    <p>Live collaborative web application built in FriKode.</p>\n    <button id="btnCounter">Clicks: 0</button>\n  </main>\n  <script src="app.js"></script>\n</body>\n</html>\n`
      };
      files["style.css"] = {
        path: "style.css",
        name: "style.css",
        is_dir: false,
        size: 340,
        content: `body {\n  font-family: system-ui, -apple-system, sans-serif;\n  background: #fdfbf7;\n  color: #111827;\n  display: grid;\n  place-items: center;\n  min-height: 100vh;\n  margin: 0;\n}\n.hero {\n  text-align: center;\n  background: #ffffff;\n  padding: 32px 40px;\n  border-radius: 12px;\n  border: 1px solid #e5e7eb;\n  box-shadow: 0 4px 12px rgba(0,0,0,0.05);\n}\nbutton {\n  background: #050505;\n  color: #fff;\n  border: none;\n  padding: 10px 22px;\n  border-radius: 8px;\n  font-weight: 600;\n  cursor: pointer;\n}\n`
      };
      files["app.js"] = {
        path: "app.js",
        name: "app.js",
        is_dir: false,
        size: 360,
        content: `// Web Application Logic\nconsole.log("App loaded for ${name}");\n\nlet count = 0;\nconst btn = document.getElementById("btnCounter");\nif (btn) {\n  btn.addEventListener("click", () => {\n    count++;\n    btn.textContent = "Clicks: " + count;\n    console.log("Counter updated to:", count);\n  });\n}\n`
      };
      files["README.md"] = {
        path: "README.md",
        name: "README.md",
        is_dir: false,
        size: 210,
        content: `# ${name}\n\nWeb App project (HTML + CSS + JS).\nPress Run to execute your JavaScript in the browser console.\n`
      };
    } else if (template === "c") {
      files["main.c"] = {
        path: "main.c",
        name: "main.c",
        is_dir: false,
        size: 260,
        content: `#include <stdio.h>\n\nint main() {\n    printf("FriKode C Workspace: %s\\n", "${name}");\n    printf("Real-time collaborative code editor\\n");\n    return 0;\n}\n`
      };
      files["README.md"] = {
        path: "README.md",
        name: "README.md",
        is_dir: false,
        size: 200,
        content: `# ${name}\n\nC/C++ Project created with FriKode.\n`
      };
    } else if (template === "blank" || template === "folder") {
      // Completely blank - zero starter files
      files = {};
    } else {
      // Default fallback - blank
      files = {};
    }

    const ws = {
      id,
      name,
      template,
      session_code: sessionCode,
      files,
      created_at: Date.now(),
      last_active: Date.now()
    };

    all[id] = ws;
    this.saveAll(all);
    this.setActiveId(id);
    return ws;
  }

  deleteWorkspace(id) {
    const all = this.getAll();
    delete all[id];
    this.saveAll(all);
    if (this.getActiveId() === id) {
      const keys = Object.keys(all);
      this.setActiveId(keys[0] || null);
    }
  }

  toTree(filesObj) {
    const tree = [];
    const dirs = new Map();

    Object.values(filesObj || {}).forEach(item => {
      const parts = item.path.split("/");
      if (parts.length === 1) {
        tree.push({
          path: item.path,
          name: item.name || item.path,
          is_dir: !!item.is_dir,
          size: item.size || (item.content ? item.content.length : 0),
          content: item.content
        });
      } else {
        let currentPath = "";
        let currentChildren = tree;
        for (let i = 0; i < parts.length - 1; i++) {
          const dirName = parts[i];
          currentPath = currentPath ? `${currentPath}/${dirName}` : dirName;
          let dirNode = dirs.get(currentPath);
          if (!dirNode) {
            dirNode = {
              path: currentPath,
              name: dirName,
              is_dir: true,
              children: []
            };
            dirs.set(currentPath, dirNode);
            currentChildren.push(dirNode);
          }
          currentChildren = dirNode.children;
        }
        currentChildren.push({
          path: item.path,
          name: parts[parts.length - 1],
          is_dir: !!item.is_dir,
          size: item.size || (item.content ? item.content.length : 0),
          content: item.content
        });
      }
    });

    return tree;
  }
}

class FriKodeApp {
  constructor() {
    this.workspaceStore = new WorkspaceStore();
    this.session = null;
    this.role = "host"; // "host" or "participant"
    this.user = {
      id: "user_" + Math.random().toString(36).substring(2, 9),
      name: safeGetStorage("frikode_name", "Developer"),
      color: safeGetStorage("frikode_color", getRandomColor())
    };

    this.editorManager = null;
    this.signalingWs = null;
    this.peers = [];
    this.treeData = [];
    this.collapsedFolders = new Set();
    this.pingInterval = null;

    this.tunnelActive = false;
    this.tunnelUrl = null;
    this._presenceProvider = null;

    // Pending file action state (for modals)
    this.pendingCreateType = "file"; // "file" or "folder"
    this.pendingDeletePath = null;

    this.init();
  }

  _isStaticMode() {
    return (window.location.hostname.endsWith("github.io") || window.location.protocol === "file:") && !api.baseUrl;
  }

  async init() {
    // 1. Immediately render fallback network UI based on origin/port (never stuck on scanning or detecting)
    try {
      this._updateNetworkUI();
    } catch (e) {
      console.warn("[FriKode] Initial network UI render error:", e);
    }

    // 2. Inject SVG icons
    try {
      this._injectIcons();
    } catch (e) {
      console.warn("[FriKode] Icon injection error:", e);
    }

    // 3. Initialize user color swatches
    try {
      this._initColorSwatches();
    } catch (e) {
      console.warn("[FriKode] Color swatches error:", e);
    }

    // 4. Bind all click events & keyboard shortcuts
    try {
      this._bindEvents();
    } catch (e) {
      console.warn("[FriKode] Event binding error:", e);
    }

    // 5. Initialize code editor
    try {
      this._initEditor();
    } catch (e) {
      console.warn("[FriKode] Editor initialization error:", e);
    }

    // 6. Check if running on a live FriKode host with automatic retry
    try {
      await this._fetchSessionWithRetry();
    } catch (e) {
      console.warn("[FriKode] Session retry error:", e);
    }

    // 7. Check URL parameters for 1-click invite (?join=1, ?room=..., ?session=..., ?code=...)
    const urlParams = new URLSearchParams(window.location.search);
    const codeParam = urlParams.get("code") || urlParams.get("session") || urlParams.get("room");
    const joinParam = urlParams.get("join");
    if (codeParam || joinParam) {
      setTimeout(() => {
        this.openJoinModal();
      }, 300);
    }
  }

  async _fetchSessionWithRetry(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.session = await api.getSession();
        this._updateNetworkUI();
        if (this.session && this.session.tunnel) {
          this._updateTunnelUI(this.session.tunnel);
        }
        return this.session;
      } catch (err) {
        if (attempt === 1) {
          console.warn("[FriKode] Backend session API pending or booting...", err);
        }
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 600 * attempt));
        }
      }
    }
    // Update UI even if fetch ultimately failed
    this._updateNetworkUI();
    return null;
  }

  _injectIcons() {
    const setIcon = (id, iconSvg) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = iconSvg;
    };
    setIcon("wifiIcon", Icons.wifi);
    setIcon("hostIconBadge", Icons.laptop);
    setIcon("joinIconBadge", Icons.users);
    setIcon("saveIcon", Icons.save);
    setIcon("activityIcon", Icons.activity);
    setIcon("newFileIcon", Icons.plus);
    setIcon("newFolderIcon", Icons.folder);
    setIcon("refreshIcon", Icons.refresh);
    setIcon("modalHostIcon", Icons.laptop);
    setIcon("modalJoinIcon", Icons.users);
    setIcon("modalCopyIcon", Icons.copy);
    setIcon("modalCopyCodeIcon", Icons.copy);
    setIcon("modalCopyPublicIcon", Icons.copy);
    setIcon("topbarCopyIcon", Icons.copy);
    setIcon("closeActivityIcon", Icons.close);
    setIcon("modalProfileIcon", Icons.users);
    setIcon("modalHostGlobeIcon", Icons.globe);
    setIcon("modalRemoteGlobeIcon", Icons.globe);
    setIcon("modalCopyRemoteIcon", Icons.copy);
    setIcon("mobileNavIcon", Icons.menu);
    setIcon("mobileSidebarIcon", Icons.menu);
    setIcon("runIcon", Icons.play);
    setIcon("compilerTerminalIcon", Icons.terminal);
    setIcon("compilerClearIcon", Icons.clear);
    setIcon("compilerMaxIcon", Icons.maximize);
    setIcon("statusConsoleIcon", Icons.terminal);
    setIcon("downloadIcon", Icons.download);
    setIcon("modalDownloadIcon", Icons.download);
    setIcon("importFolderIcon", Icons.upload);
    setIcon("downloadWorkspaceIcon", Icons.download);
    setIcon("modalSwitchIcon", Icons.layers);
  }

  _initColorSwatches(containerId = "colorSwatches", onColorSelect = null) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = "";
    ACCENT_COLORS.forEach(color => {
      const swatch = document.createElement("div");
      swatch.className = `color-swatch ${color === this.user.color ? "selected" : ""}`;
      swatch.style.backgroundColor = color;
      swatch.onclick = () => {
        container.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("selected"));
        swatch.classList.add("selected");
        this.user.color = color;
        safeSetStorage("frikode_color", color);
        if (this.editorManager) {
          this.editorManager.setUser(this.user.name, this.user.color);
        }
        this._updateUserProfileButton();
        if (onColorSelect) onColorSelect(color);
      };
      container.appendChild(swatch);
    });
  }

  _initEditor() {
    this.editorManager = new EditorManager({
      onCursorChange: ({ line, col }) => {
        const posEl = document.getElementById("statusCursorPos");
        if (posEl) posEl.textContent = `Ln ${line}, Col ${col}`;
      },
      onSaveStateChange: (state) => {
        const dot = document.getElementById("syncStatusDot");
        const text = document.getElementById("syncStatusText");
        const btn = document.getElementById("btnSyncOnline");
        if (dot) dot.className = `sync-dot ${state}`;
        if (btn) {
          if (state === "saving") btn.classList.add("syncing");
          else btn.classList.remove("syncing");
        }
        if (text) {
          if (state === "synced") text.textContent = "Synced";
          else if (state === "saving") text.textContent = "Saving...";
          else if (state === "unsaved") text.textContent = "Unsaved";
          else if (state === "error") text.textContent = "Save Error";
        }
      },
      onTabChange: (tabInfo) => {
        const langEl = document.getElementById("statusLanguage");
        const compilerLangEl = document.getElementById("compilerLangBadge");
        if (langEl) {
          if (tabInfo) {
            const mode = tabInfo.mode.toUpperCase();
            langEl.textContent = mode;
            if (compilerLangEl) compilerLangEl.textContent = mode;
            this._notifyFileFocus(tabInfo.path);
          } else {
            langEl.textContent = "Plain Text";
            if (compilerLangEl) compilerLangEl.textContent = "PYTHON";
            this._notifyFileFocus(null);
          }
        }
        if (this._presenceProvider && this._presenceProvider.awareness) {
          this._presenceProvider.awareness.setLocalStateField("user", {
            name: this.user.name,
            color: this.user.color,
            role: this.role,
            file: tabInfo ? tabInfo.path : ""
          });
        }
      },
      onAwarenessChange: (states) => {
        if (this._isStaticMode()) {
          this._handleAwarenessPeers(states);
        }
      },
      onFileSave: (path, content) => {
        const activeWs = this.workspaceStore.getActiveWorkspace();
        if (activeWs && activeWs.files) {
          if (!activeWs.files[path]) {
            activeWs.files[path] = {
              path,
              name: path.split("/").pop(),
              is_dir: false,
              size: content.length,
              content
            };
          } else {
            activeWs.files[path].content = content;
            activeWs.files[path].size = content.length;
          }
          this.workspaceStore.saveWorkspace(activeWs);
        }
        if (this._filesMap) {
          this._filesMap.set(path, {
            path,
            name: path.split("/").pop(),
            is_dir: false,
            size: content.length,
            content
          });
        }
      }
    });

    this.editorManager.setUser(this.user.name, this.user.color);
    this.editorManager.setRole(this.role);
  }

  _bindEvents() {
    const bindClick = (id, handler) => {
      const el = document.getElementById(id);
      if (el) {
        el.onclick = (e) => {
          try {
            handler(e);
          } catch (err) {
            console.error(`[FriKode] Error in click handler for #${id}:`, err);
          }
        };
      }
    };

    // Landing Header Navigation Buttons
    bindClick("btnNavHost", () => this.openHostModal());
    bindClick("btnNavJoin", () => this.openJoinModal());

    // Landing Nav Smooth Scrolling
    document.querySelectorAll(".landing-nav-links a").forEach(anchor => {
      anchor.addEventListener("click", (e) => {
        e.preventDefault();
        const targetId = anchor.getAttribute("href")?.replace("#", "");
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: "smooth" });
        }
      });
    });

    const homeView = document.getElementById("homeView");
    const landingHeader = document.querySelector(".landing-header");
    if (homeView && landingHeader) {
      homeView.addEventListener("scroll", () => {
        if (homeView.scrollTop > 24) {
          landingHeader.classList.add("scrolled");
        } else {
          landingHeader.classList.remove("scrolled");
        }
      }, { passive: true });
    }

    // Home Hero Action Buttons
    bindClick("btnHostCard", () => this.openHostModal());
    bindClick("btnOpenHostModal", (e) => { e.stopPropagation(); this.openHostModal(); });
    bindClick("btnJoinCard", () => this.openJoinModal());
    bindClick("btnOpenJoinModal", (e) => { e.stopPropagation(); this.openJoinModal(); });

    // Host Modal
    bindClick("btnCloseHostModal", () => this.closeModal("hostModal"));
    bindClick("btnCancelHost", () => this.closeModal("hostModal"));
    bindClick("btnConfirmHost", () => this.confirmHost());
    bindClick("btnCopyModalAddress", () => {
      const addr = document.getElementById("modalHostWifiAddress")?.textContent || "";
      copyToClipboard(addr, "Wi-Fi address copied!");
    });
    bindClick("btnCopyModalCode", () => {
      const code = document.getElementById("modalHostSessionCode")?.textContent || "";
      copyToClipboard(code, "Session code copied!");
    });
    bindClick("btnCopyModalPublicAddress", () => {
      const addr = document.getElementById("modalHostPublicAddress")?.textContent || "";
      copyToClipboard(addr, "Remote link copied!");
    });

    // Join Modal
    bindClick("btnCloseJoinModal", () => this.closeModal("joinModal"));
    bindClick("btnTestJoinConnection", () => this.testJoinPing());
    bindClick("btnConfirmJoin", () => this.confirmJoin());

    // Profile & Host Role Modal
    bindClick("btnUserProfile", () => this.openProfileModal());
    bindClick("btnCloseProfileModal", () => this.closeModal("profileModal"));
    bindClick("btnCancelProfile", () => this.closeModal("profileModal"));
    bindClick("btnSaveProfile", () => this.confirmSaveProfile());
    bindClick("btnTransferHostConfirm", () => this.confirmTransferHostFromModal());

    const cardHost = document.getElementById("cardRoleHost");
    const cardPeer = document.getElementById("cardRolePeer");
    if (cardHost) {
      cardHost.onclick = () => {
        const radio = document.getElementById("radioRoleHost");
        if (radio) radio.checked = true;
        cardHost.classList.add("selected");
        if (cardPeer) cardPeer.classList.remove("selected");
      };
    }
    if (cardPeer) {
      cardPeer.onclick = () => {
        const radio = document.getElementById("radioRolePeer");
        if (radio) radio.checked = true;
        cardPeer.classList.add("selected");
        if (cardHost) cardHost.classList.remove("selected");
      };
    }

    // Mobile Navigation & Sidebar Toggles
    bindClick("btnMobileNavToggle", () => this.toggleMobileNav());
    bindClick("btnToggleMobileSidebar", () => this.toggleMobileSidebar());
    bindClick("sidebarBackdrop", () => this.toggleMobileSidebar(false));

    // Compiler & Run Code Controls
    bindClick("btnRunCode", () => this.runCurrentCode());
    bindClick("btnToggleConsoleStatus", () => this.toggleCompilerPanel());
    bindClick("btnCloseCompiler", () => this.toggleCompilerPanel(false));
    bindClick("btnMaximizeCompiler", () => this.toggleCompilerMaximize());
    bindClick("btnClearOutput", () => this.clearCompilerOutput());
    bindClick("btnToggleStdin", () => this.toggleStdinBar());
    bindClick("btnRunStdin", () => this.runCurrentCode(true));

    const stdinInput = document.getElementById("compilerStdinInput");
    if (stdinInput) {
      stdinInput.onkeydown = (e) => {
        if (e.key === "Enter") this.runCurrentCode(true);
      };
    }

    // Remote Collaboration Modal
    bindClick("btnOpenRemoteModal", () => this.openRemoteModal());
    bindClick("btnCloseRemoteModal", () => this.closeModal("remoteModal"));
    bindClick("btnCloseRemoteModalFooter", () => this.closeModal("remoteModal"));
    bindClick("btnToggleTunnelAction", () => this.toggleTunnel());
    bindClick("btnCopyRemoteLink", () => this.copyRemoteLink());
    bindClick("btnCopyInviteMessage", () => this.copyInviteMessage());
    bindClick("btnApplyCustomUrl", () => this.applyCustomTunnelUrl());

    // Top Bar Actions
    document.getElementById("btnCopyInvite").onclick = () => {
      const fullUrl = this._getInviteUrl();
      const label = this.tunnelUrl ? "Remote invite link copied!" : "Wi-Fi invite address copied!";
      copyToClipboard(fullUrl, label);
    };
    const btnSync = document.getElementById("btnSyncOnline");
    if (btnSync) btnSync.onclick = () => this.syncOnline();
    const btnSave = document.getElementById("btnSaveFile");
    if (btnSave) btnSave.onclick = () => this.syncOnline();

    const btnDownload = document.getElementById("btnDownloadFile");
    if (btnDownload) btnDownload.onclick = () => this.openDownloadModal();

    bindClick("btnCloseDownloadModal", () => this.closeModal("downloadModal"));
    bindClick("btnCancelDownload", () => this.closeModal("downloadModal"));
    bindClick("btnDownloadCurrentFileAction", () => this.downloadActiveFile());
    bindClick("btnDownloadFullFolderAction", () => this.downloadFullFolderZip());

    const cardDlFile = document.getElementById("cardDownloadActiveFile");
    if (cardDlFile) {
      cardDlFile.onclick = (e) => {
        if (e.target.tagName !== "BUTTON") this.downloadActiveFile();
      };
    }
    const cardDlZip = document.getElementById("cardDownloadFullFolder");
    if (cardDlZip) {
      cardDlZip.onclick = (e) => {
        if (e.target.tagName !== "BUTTON") this.downloadFullFolderZip();
      };
    }

    const btnImportFolder = document.getElementById("btnImportFolder");
    if (btnImportFolder) btnImportFolder.onclick = () => this.triggerFolderImport();

    const btnEmptyNewFile = document.getElementById("btnEmptyNewFile");
    if (btnEmptyNewFile) btnEmptyNewFile.onclick = () => this.openCreateEntryModal("file");
    const btnEmptyImportFolder = document.getElementById("btnEmptyImportFolder");
    if (btnEmptyImportFolder) btnEmptyImportFolder.onclick = () => this.triggerFolderImport();

    const folderInput = document.getElementById("folderImportInput");
    if (folderInput) {
      folderInput.onchange = (e) => this.handleFolderFilesSelected(e.target.files);
    }
    const fileInput = document.getElementById("fileImportInput");
    if (fileInput) {
      fileInput.onchange = (e) => this.handleFolderFilesSelected(e.target.files);
    }

    document.getElementById("btnToggleActivity").onclick = () => {
      const drawer = document.getElementById("activityDrawer");
      drawer.classList.toggle("collapsed");
    };
    document.getElementById("btnCloseActivity").onclick = () => {
      document.getElementById("activityDrawer").classList.add("collapsed");
    };
    document.getElementById("btnLeaveSession").onclick = () => this.leaveSession();
    document.getElementById("btnWorkspaceBrand").onclick = (e) => {
      e.preventDefault();
      // Prompt before returning home
      if (confirm("Return to home screen? Active collaboration will stay open.")) {
        this.switchView("homeView");
      }
    };

    // Sidebar File Explorer
    document.getElementById("btnNewFile").onclick = () => this.openCreateEntryModal("file");
    document.getElementById("btnNewFolder").onclick = () => this.openCreateEntryModal("folder");
    document.getElementById("btnRefreshFiles").onclick = () => this.loadFiles();
    const btnDownloadWs = document.getElementById("btnDownloadWorkspace");
    if (btnDownloadWs) {
      btnDownloadWs.onclick = () => this.openDownloadModal();
    }

    // Workspace Switching & Management
    const btnSwitch = document.getElementById("btnSwitchWorkspace");
    if (btnSwitch) {
      btnSwitch.onclick = () => this.openSwitchWorkspaceModal();
    }
    const btnCloseSwitch = document.getElementById("btnCloseSwitchWorkspaceModal");
    if (btnCloseSwitch) btnCloseSwitch.onclick = () => this.closeModal("switchWorkspaceModal");
    const btnCloseSwitchFooter = document.getElementById("btnCloseSwitchModalFooter");
    if (btnCloseSwitchFooter) btnCloseSwitchFooter.onclick = () => this.closeModal("switchWorkspaceModal");
    const btnCreateFromModal = document.getElementById("btnCreateNewWorkspaceFromModal");
    if (btnCreateFromModal) {
      btnCreateFromModal.onclick = () => {
        this.closeModal("switchWorkspaceModal");
        this.openHostModal();
      };
    }

    // Host Template Cards Selection
    document.querySelectorAll("#hostTemplateGrid .template-card").forEach(card => {
      card.onclick = async () => {
        document.querySelectorAll("#hostTemplateGrid .template-card").forEach(c => c.classList.remove("selected"));
        card.classList.add("selected");
        if (card.dataset.template === "folder") {
          try {
            await this.pickFolderForHost();
          } catch (err) {
            console.warn("Folder picker error:", err);
          }
        } else {
          this._pendingFolderFiles = null;
          this._pendingFolderName = null;
          const descEl = document.getElementById("cardTemplateFolderDesc");
          if (descEl) descEl.textContent = "Pick from device";
        }
      };
    });

    const hostFolderInput = document.getElementById("hostFolderInput");
    if (hostFolderInput) {
      hostFolderInput.onchange = (e) => this._readFileInputIntoHost(e.target.files);
    }

    // Create Entry Modal
    document.getElementById("btnCloseCreateEntryModal").onclick = () => this.closeModal("createEntryModal");
    document.getElementById("btnCancelCreateEntry").onclick = () => this.closeModal("createEntryModal");
    document.getElementById("btnConfirmCreateEntry").onclick = () => this.confirmCreateEntry();
    document.getElementById("createEntryInput").onkeydown = (e) => {
      if (e.key === "Enter") this.confirmCreateEntry();
    };

    // Delete Modal
    document.getElementById("btnCloseDeleteModal").onclick = () => this.closeModal("deleteConfirmModal");
    document.getElementById("btnCancelDelete").onclick = () => this.closeModal("deleteConfirmModal");
    document.getElementById("btnConfirmDelete").onclick = () => this.confirmDeleteEntry();

    // Session Ended Modal
    document.getElementById("btnReturnHome").onclick = () => {
      this.closeModal("sessionEndedModal");
      this.switchView("homeView");
    };

    // Global Keyboard Shortcuts
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        this.editorManager.saveCurrentFile();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.runCurrentCode();
      }
      if (e.key === "Escape") {
        document.querySelectorAll(".modal-backdrop.active").forEach(m => m.classList.remove("active"));
        this.toggleMobileSidebar(false);
      }
    });

    // Window Resize Handler (ensures editor layout & CodeMirror adapt instantly to window sizing)
    let resizeDebounce = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => {
        if (this.editorManager?.cm) {
          this.editorManager.cm.refresh();
        }
      }, 100);
    });
  }

  // -------------------------------------------------------------
  // View & Modal Management
  // -------------------------------------------------------------
  switchView(viewId) {
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    const target = document.getElementById(viewId);
    if (target) target.classList.add("active");
  }

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add("active");
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove("active");
  }

  // -------------------------------------------------------------
  // Hosting Flow
  // -------------------------------------------------------------
  async openHostModal() {
    const nameInput = document.getElementById("hostNameInput");
    if (nameInput) {
      nameInput.value = safeGetStorage("frikode_name", this.user.name || "Developer");
    }
    const wsInput = document.getElementById("hostWorkspaceInput");
    if (wsInput) {
      wsInput.value = "My Project";
    }
    this._pendingFolderFiles = null;
    this._pendingFolderName = null;
    const descEl = document.getElementById("cardTemplateFolderDesc");
    if (descEl) descEl.textContent = "Pick from device";

    // Reset template selection to python
    document.querySelectorAll("#hostTemplateGrid .template-card").forEach(c => {
      if (c.dataset.template === "python") c.classList.add("selected");
      else c.classList.remove("selected");
    });

    this._initColorSwatches("hostColorSwatches");
    this._updateNetworkUI(); // Immediate render using current origin/port
    this.openModal("hostModal"); // Open modal instantly on click
    try {
      this.session = await api.getSession();
      this._updateNetworkUI();
      if (this.session && this.session.tunnel) {
        this._updateTunnelUI(this.session.tunnel);
      }
    } catch (err) {
      console.warn("Could not refresh session info:", err);
      this._updateNetworkUI();
    }
  }

  async confirmHost() {
    const btn = document.getElementById("btnConfirmHost");
    const origHtml = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span>Creating workspace...</span>`;
    }

    try {
      const selectedCard = document.querySelector("#hostTemplateGrid .template-card.selected");
      const template = selectedCard?.dataset?.template || "python";
      let folderFiles = null;
      if (template === "folder" && this._pendingFolderFiles && Object.keys(this._pendingFolderFiles).length > 0) {
        folderFiles = { ...this._pendingFolderFiles };
      }

      const defaultName = template === "folder" ? (this._pendingFolderName || "Imported Project") : "My Project";
      const workspaceInput = document.getElementById("hostWorkspaceInput")?.value?.trim() || defaultName;
      const hostName = document.getElementById("hostNameInput")?.value?.trim() || safeGetStorage("frikode_name", "Developer");
      const enableTunnel = document.getElementById("hostEnableTunnelCheckbox")?.checked ?? true;

      this.user.name = hostName;
      safeSetStorage("frikode_name", hostName);

      const isStandaloneStatic = this._isStaticMode();

      // 1. If backend exists, create session on backend
      if (!isStandaloneStatic) {
        try {
          const res = await api.createSession(workspaceInput, false, template, folderFiles);
          if (!this.session) this.session = {};
          this.session.session_code = res.session_code;
          this.session.workspace_name = res.workspace_name;
          api.setSessionCode(res.session_code);
        } catch (err) {
          console.warn("Backend session creation skipped/fallback:", err);
        }
      }

      // 2. Always persist workspace into local WorkspaceStore
      const initialFiles = folderFiles || (template === "blank" ? {} : null);
      const ws = this.workspaceStore.createWorkspace(workspaceInput, template, this.session?.session_code, initialFiles);
      if (!this.session) this.session = {};
      this.session.session_code = this.session.session_code || ws.session_code;
      this.session.workspace_name = ws.name;
      this.session.template = template;

      // Clean up pending state
      this._pendingFolderFiles = null;
      this._pendingFolderName = null;
      const descEl = document.getElementById("cardTemplateFolderDesc");
      if (descEl) descEl.textContent = "Pick from device";

      this.role = "host";
      this.editorManager?.setUser(this.user.name, this.user.color);
      this.editorManager?.setRole("host");
      this.editorManager?.setSessionCode(this.session.session_code);

      this.closeModal("hostModal");
      await this.enterWorkspace();
      showToast(`Workspace "${ws.name}" created!`, "success");

      if (enableTunnel && !this.tunnelActive) {
        if (isStandaloneStatic) {
          const inviteUrl = this._getInviteUrl();
          this._updateTunnelUI({
            active: true,
            url: inviteUrl,
            provider: "Web / GitHub Pages",
            error: null
          });
          showToast("Remote link ready: " + inviteUrl, "success");
        } else {
          showToast("Starting remote access link...", "info");
          api.startTunnel("auto").then(t => {
            this._updateTunnelUI(t);
            if (t && t.active && t.url) {
              showToast("Remote link ready: " + t.url, "success");
            }
          }).catch(err => {
            console.warn("Tunnel auto-start failed:", err);
          });
        }
      }
    } catch (err) {
      console.error("Error creating workspace:", err);
      showToast("Error creating workspace: " + (err.message || err), "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    }
  }

  // -------------------------------------------------------------
  // Workspace Switching & Management
  // -------------------------------------------------------------
  openSwitchWorkspaceModal() {
    const list = document.getElementById("savedWorkspacesList");
    if (!list) return;
    const all = this.workspaceStore.getAll();
    const activeId = this.workspaceStore.getActiveId();
    const entries = Object.values(all);

    if (entries.length === 0) {
      list.innerHTML = `<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 12px;">No saved workspaces yet. Click "+ New Workspace" below.</div>`;
    } else {
      list.innerHTML = entries.map(ws => {
        const isActive = ws.id === activeId;
        const fileCount = Object.keys(ws.files || {}).length;
        const templateBadge = (ws.template || "custom").toUpperCase();
        return `
          <div class="workspace-item ${isActive ? "active" : ""}">
            <div class="workspace-item-info">
              <div class="workspace-item-title-row">
                <span class="workspace-item-name">${this._escapeHtml(ws.name)}</span>
                <span class="badge-role ${isActive ? "host" : "peer"}" style="font-size: 9px; padding: 1px 5px;">${templateBadge}</span>
                ${isActive ? `<span style="font-size: 10px; color: #10b981; font-weight: 700;">● Active</span>` : ""}
              </div>
              <span class="workspace-item-meta">${fileCount} files • Code: ${ws.session_code || "FRI-READY"}</span>
            </div>
            <div class="workspace-item-actions">
              ${!isActive ? `<button class="peer-mini-btn lime" data-switch-id="${ws.id}">Open</button>` : ""}
              <button class="peer-mini-btn" data-delete-ws="${ws.id}" title="Delete workspace">✕</button>
            </div>
          </div>
        `;
      }).join("");

      list.querySelectorAll("[data-switch-id]").forEach(btn => {
        btn.onclick = () => {
          this.switchWorkspace(btn.dataset.switchId);
          this.closeModal("switchWorkspaceModal");
        };
      });

      list.querySelectorAll("[data-delete-ws]").forEach(btn => {
        btn.onclick = () => {
          const wsId = btn.dataset.deleteWs;
          if (confirm("Delete this workspace from your browser?")) {
            this.workspaceStore.deleteWorkspace(wsId);
            this.openSwitchWorkspaceModal();
          }
        };
      });
    }

    this.openModal("switchWorkspaceModal");
  }

  async switchWorkspace(wsId) {
    this.workspaceStore.setActiveId(wsId);
    const ws = this.workspaceStore.getActiveWorkspace();
    if (ws) {
      if (!this.session) this.session = {};
      this.session.workspace_name = ws.name;
      this.session.session_code = ws.session_code;
      api.setSessionCode(ws.session_code);
      const titleEl = document.getElementById("topbarProjectName");
      if (titleEl) titleEl.textContent = ws.name;
      const codeEl = document.getElementById("topbarSessionCode");
      if (codeEl) codeEl.textContent = ws.session_code || "FRI-....";
      this.editorManager?.setSessionCode(ws.session_code);
      this.editorManager?.closeAllTabs();
      if (this._isStaticMode()) {
        this._connectStaticPresence(ws.session_code);
      }
      await this.loadFiles();
      showToast(`Switched to "${ws.name}"`, "info");
    }
  }

  async syncOnline() {
    const dot = document.getElementById("syncStatusDot");
    const text = document.getElementById("syncStatusText");
    const btn = document.getElementById("btnSyncOnline");

    if (btn) btn.classList.add("syncing");
    if (dot) dot.className = "sync-dot saving";
    if (text) text.textContent = "Saving...";

    try {
      if (this.editorManager?.activePath) {
        await this.editorManager.saveCurrentFile();
      }

      // Persist workspace to local store and broadcast to Yjs shared files map
      const activeWs = this.workspaceStore.getActiveWorkspace();
      if (activeWs && activeWs.files) {
        this.workspaceStore.saveWorkspace(activeWs);
        if (this._filesMap) {
          for (const [path, f] of Object.entries(activeWs.files)) {
            this._filesMap.set(path, f);
          }
        }
      }

      if (dot) dot.className = "sync-dot synced";
      if (text) text.textContent = "Synced Online";
      if (btn) {
        btn.classList.remove("syncing");
        setTimeout(() => {
          if (text && text.textContent === "Synced Online") text.textContent = "Synced";
        }, 2200);
      }
      showToast("Workspace saved & synchronized online!", "success");
    } catch (err) {
      console.error("Sync online error:", err);
      if (dot) dot.className = "sync-dot error";
      if (text) text.textContent = "Sync Error";
      if (btn) btn.classList.remove("syncing");
      showToast("Failed to save & sync: " + (err.message || err), "error");
    }
  }

  openDownloadModal() {
    const activePath = this.editorManager?.activePath;
    const activeFileNameEl = document.getElementById("downloadActiveFileName");
    const activeFileSubEl = document.getElementById("downloadActiveFileSub");
    const cardActiveFile = document.getElementById("cardDownloadActiveFile");
    const btnActiveFile = document.getElementById("btnDownloadCurrentFileAction");
    const activeFileIconEmoji = document.getElementById("downloadFileIconEmoji");

    const activeWs = this.workspaceStore.getActiveWorkspace();
    const wsName = activeWs?.name || "workspace";
    const zipNameEl = document.getElementById("downloadZipName");
    const zipCountEl = document.getElementById("downloadZipFileCount");

    const filesCount = activeWs?.files ? Object.values(activeWs.files).filter(f => !f.is_dir).length : 0;
    if (zipNameEl) zipNameEl.textContent = `${wsName}.zip`;
    if (zipCountEl) zipCountEl.textContent = `Export all ${filesCount} project files as a ZIP archive`;

    if (activePath) {
      const fileName = activePath.split("/").pop();
      if (activeFileNameEl) activeFileNameEl.textContent = fileName;
      if (activeFileSubEl) activeFileSubEl.textContent = `Path: ${activePath}`;
      if (cardActiveFile) cardActiveFile.classList.remove("disabled");
      if (btnActiveFile) btnActiveFile.disabled = false;
      const ext = fileName.split(".").pop().toLowerCase();
      if (["py"].includes(ext)) activeFileIconEmoji.textContent = "🐍";
      else if (["js", "ts"].includes(ext)) activeFileIconEmoji.textContent = "⚡";
      else if (["html", "htm"].includes(ext)) activeFileIconEmoji.textContent = "🌐";
      else if (["c", "cpp", "h"].includes(ext)) activeFileIconEmoji.textContent = "⚙️";
      else activeFileIconEmoji.textContent = "📄";
    } else {
      if (activeFileNameEl) activeFileNameEl.textContent = "No File Open";
      if (activeFileSubEl) activeFileSubEl.textContent = "Open a file in the editor to download it individually";
      if (cardActiveFile) cardActiveFile.classList.add("disabled");
      if (btnActiveFile) btnActiveFile.disabled = true;
      if (activeFileIconEmoji) activeFileIconEmoji.textContent = "📄";
    }

    this.openModal("downloadModal");
  }

  downloadActiveFile() {
    const activePath = this.editorManager?.activePath;
    if (!activePath) {
      showToast("No active file to download", "info");
      return;
    }
    const content = this.editorManager.getValue();
    const fileName = activePath.split("/").pop();
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    this.closeModal("downloadModal");
    showToast(`Downloaded ${fileName}`, "success");
  }

  downloadFullFolderZip() {
    const activeWs = this.workspaceStore.getActiveWorkspace();
    if (!activeWs || !activeWs.files || Object.keys(activeWs.files).length === 0) {
      showToast("No files to download in workspace", "error");
      return;
    }

    // Include any latest unsaved edits from active editor tab
    if (this.editorManager?.activePath) {
      const currentText = this.editorManager.getValue();
      if (activeWs.files[this.editorManager.activePath]) {
        activeWs.files[this.editorManager.activePath].content = currentText;
      }
    }

    const fileEntries = Object.entries(activeWs.files)
      .filter(([_, f]) => !f.is_dir)
      .map(([path, f]) => ({
        path,
        content: f.content !== undefined ? f.content : ""
      }));

    if (fileEntries.length === 0) {
      showToast("Workspace is empty", "info");
      return;
    }

    try {
      const zipBytes = createZipArchive(fileEntries);
      const blob = new Blob([zipBytes], { type: "application/zip" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const safeWsName = (activeWs.name || "workspace").replace(/[^a-zA-Z0-9_\-\.]/g, "_");
      a.download = `${safeWsName}.zip`;
      a.click();
      this.closeModal("downloadModal");
      showToast(`Downloaded ${a.download} (${fileEntries.length} files)`, "success");
    } catch (err) {
      console.error("ZIP packaging error:", err);
      showToast("Failed to create ZIP: " + (err.message || err), "error");
    }
  }

  downloadCurrentWorkspace() {
    this.openDownloadModal();
  }

  triggerFolderImport() {
    const folderInput = document.getElementById("folderImportInput");
    if (folderInput) {
      folderInput.value = "";
      folderInput.click();
    }
  }

  async handleFolderFilesSelected(filesList) {
    if (!filesList || filesList.length === 0) return;

    let activeWs = this.workspaceStore.getActiveWorkspace();
    if (!activeWs) {
      activeWs = this.workspaceStore.createWorkspace("Imported Project", "blank");
    }
    if (!activeWs.files) activeWs.files = {};

    let importedCount = 0;
    let firstFilePath = null;

    // Detect if files have a common root directory prefix (e.g. "my-project/src/index.js")
    const paths = Array.from(filesList).map(f => f.webkitRelativePath || f.name);
    let rootPrefix = "";
    if (paths.length > 0 && paths[0].includes("/")) {
      const firstSegment = paths[0].split("/")[0];
      const allSharePrefix = paths.every(p => p.startsWith(firstSegment + "/"));
      if (allSharePrefix) {
        rootPrefix = firstSegment + "/";
        if (activeWs.name === "My Project" || activeWs.name === "My Workspace" || activeWs.name === "Imported Project") {
          activeWs.name = firstSegment;
          const titleEl = document.getElementById("topbarProjectName");
          if (titleEl) titleEl.textContent = firstSegment;
        }
      }
    }

    for (const file of filesList) {
      let relPath = file.webkitRelativePath || file.name;
      if (rootPrefix && relPath.startsWith(rootPrefix)) {
        relPath = relPath.substring(rootPrefix.length);
      }
      if (!relPath) continue;

      // Skip unwanted files (.git, .DS_Store, node_modules, pycache)
      const parts = relPath.split("/");
      if (parts.some(p => p === ".git" || p === "node_modules" || p === ".venv" || p === "__pycache__" || p === ".DS_Store")) {
        continue;
      }
      if (file.name === ".DS_Store" || file.name.endsWith(".pyc")) {
        continue;
      }

      // Check file size limit (skip files > 5MB)
      if (file.size > 5 * 1024 * 1024) {
        console.warn(`Skipping large file: ${relPath} (${file.size} bytes)`);
        continue;
      }

      try {
        const content = await file.text();
        activeWs.files[relPath] = {
          path: relPath,
          name: relPath.split("/").pop(),
          is_dir: false,
          size: file.size,
          content: content
        };
        importedCount++;

        // Save to backend if backend server is running
        if (!this._isStaticMode()) {
          api.saveFile(relPath, content, this.user.name).catch(() => {});
        }

        if (!firstFilePath && !relPath.endsWith(".md") && !relPath.endsWith(".png") && !relPath.endsWith(".jpg")) {
          firstFilePath = relPath;
        }
      } catch (err) {
        console.warn(`Error reading ${relPath}:`, err);
      }
    }

    if (importedCount === 0) {
      showToast("No readable code files found in selected folder", "info");
      return;
    }

    this.workspaceStore.saveWorkspace(activeWs);

    // Sync to Yjs CRDT files map for all collaborators
    if (this._filesMap) {
      for (const [p, f] of Object.entries(activeWs.files)) {
        this._filesMap.set(p, f);
      }
    }

    this.treeData = this.workspaceStore.toTree(activeWs.files);
    this._renderFileTree();

    const targetToOpen = firstFilePath || Object.keys(activeWs.files)[0];
    if (targetToOpen) {
      this.editorManager.openFile(targetToOpen, activeWs.files[targetToOpen]?.content);
    }

    showToast(`Successfully imported ${importedCount} files into workspace!`, "success");
  }

  async pickFolderForHost() {
    if (window.showDirectoryPicker) {
      try {
        const dirHandle = await window.showDirectoryPicker();
        await this._readDirectoryHandleIntoHost(dirHandle);
      } catch (err) {
        if (err.name !== "AbortError") {
          console.warn("showDirectoryPicker failed, falling back to input:", err);
          this._triggerHostFolderFallbackInput();
        }
      }
    } else {
      this._triggerHostFolderFallbackInput();
    }
  }

  _triggerHostFolderFallbackInput() {
    const input = document.getElementById("hostFolderInput");
    if (input) {
      input.value = "";
      input.click();
    }
  }

  async _readDirectoryHandleIntoHost(dirHandle) {
    if (!dirHandle) return;
    const wsName = dirHandle.name || "Device Project";
    const files = {};

    const readDirectory = async (handle, prefix = "") => {
      for await (const entry of handle.values()) {
        const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.kind === "file") {
          const parts = fullPath.split("/");
          if (parts.some(p => p === ".git" || p === "node_modules" || p === ".venv" || p === "__pycache__" || p === ".DS_Store")) {
            continue;
          }
          if (entry.name === ".DS_Store" || entry.name.endsWith(".pyc")) continue;
          try {
            const file = await entry.getFile();
            if (file.size < 5 * 1024 * 1024) {
              const content = await file.text();
              files[fullPath] = {
                path: fullPath,
                name: entry.name,
                is_dir: false,
                size: file.size,
                content: content
              };
            }
          } catch (_) {}
        } else if (entry.kind === "directory") {
          if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".venv" || entry.name === "__pycache__" || entry.name === ".DS_Store") {
            continue;
          }
          files[fullPath] = {
            path: fullPath,
            name: entry.name,
            is_dir: true,
            size: 0,
            content: ""
          };
          await readDirectory(entry, fullPath);
        }
      }
    };

    await readDirectory(dirHandle);
    this._setPendingHostFolder(wsName, files);
  }

  async _readFileInputIntoHost(filesList) {
    if (!filesList || filesList.length === 0) return;
    const files = {};
    let wsName = "Device Project";

    const paths = Array.from(filesList).map(f => f.webkitRelativePath || f.name);
    let rootPrefix = "";
    if (paths.length > 0 && paths[0].includes("/")) {
      const firstSegment = paths[0].split("/")[0];
      if (paths.every(p => p.startsWith(firstSegment + "/"))) {
        rootPrefix = firstSegment + "/";
        wsName = firstSegment;
      }
    }

    for (const file of filesList) {
      let relPath = file.webkitRelativePath || file.name;
      if (rootPrefix && relPath.startsWith(rootPrefix)) {
        relPath = relPath.substring(rootPrefix.length);
      }
      if (!relPath) continue;

      const parts = relPath.split("/");
      if (parts.some(p => p === ".git" || p === "node_modules" || p === ".venv" || p === "__pycache__" || p === ".DS_Store")) {
        continue;
      }
      if (file.name === ".DS_Store" || file.name.endsWith(".pyc")) continue;
      if (file.size > 5 * 1024 * 1024) continue;

      try {
        const content = await file.text();
        files[relPath] = {
          path: relPath,
          name: relPath.split("/").pop(),
          is_dir: false,
          size: file.size,
          content: content
        };
      } catch (_) {}
    }

    this._setPendingHostFolder(wsName, files);
  }

  _setPendingHostFolder(wsName, files) {
    this._pendingFolderFiles = files;
    this._pendingFolderName = wsName;

    const nameInput = document.getElementById("hostWorkspaceInput");
    if (nameInput) nameInput.value = wsName;

    const fileCount = Object.values(files).filter(f => !f.is_dir).length;
    const descEl = document.getElementById("cardTemplateFolderDesc");
    if (descEl) descEl.textContent = `Ready: ${fileCount} files`;

    const folderCard = document.getElementById("cardTemplateFolder");
    if (folderCard) {
      document.querySelectorAll("#hostTemplateGrid .template-card").forEach(c => c.classList.remove("selected"));
      folderCard.classList.add("selected");
    }

    showToast(`Folder "${wsName}" selected (${fileCount} files)! Click "Create & Host Workspace" to open.`, "success");
  }

  _handleAwarenessPeers(states) {
    if (!states || states.length === 0) return;
    const peerMap = new Map();
    states.forEach((s) => {
      const clientKey = s.isLocal ? this.user.id : (s.clientId ? `client_${s.clientId}` : (s.user?.id || `p2p_${s.user?.name}_${s.user?.color}`));
      const userName = s.user?.name || (s.isLocal ? this.user.name : "Collaborator");
      const userColor = s.user?.color || (s.isLocal ? this.user.color : "#38bdf8");
      const role = s.isLocal ? this.role : (s.user?.role || (this.role === "host" ? "peer" : "host"));
      peerMap.set(clientKey, {
        id: clientKey,
        clientId: s.clientId,
        name: userName,
        color: userColor,
        role: role,
        isLocal: !!s.isLocal,
        active_file: s.user?.file || (s.isLocal ? this.editorManager?.getActiveFile() || "" : "")
      });
    });
    this.peers = Array.from(peerMap.values());
    this._renderPeers();
  }

  _connectStaticPresence(code) {
    if (this._presenceProvider) {
      try {
        this._presenceProvider.destroy();
      } catch (_) {}
      this._presenceProvider = null;
    }
    try {
      const cleanCode = (code || "FRI-PEER").toUpperCase().trim().replace(/^FRI-/, "FRI-");
      const wsUrl = "wss://demos.yjs.dev/ws";
      const roomName = `frikode-${cleanCode}-presence`;
      const doc = new Y.Doc();
      this._presenceProvider = new WebsocketProvider(wsUrl, roomName, doc, { connect: true });
      this._filesMap = doc.getMap("workspace_files");

      // Synchronize workspace files from the shared map in real time
      this._filesMap.observe(() => {
        this._syncFilesFromMap();
      });

      // When the presence room finishes initial synchronization:
      this._presenceProvider.on("sync", (isSynced) => {
        if (isSynced) {
          if (this._filesMap.size === 0 && this.role === "host") {
            // First peer (Host) in the room: publish local active workspace files for this session
            let activeWs = null;
            if (this.session?.session_code) {
              activeWs = this.workspaceStore.getWorkspaceByCode(this.session.session_code);
            }
            if (!activeWs) {
              const activeCandidate = this.workspaceStore.getActiveWorkspace();
              if (activeCandidate && (!this.session?.session_code || activeCandidate.session_code === this.session.session_code)) {
                activeWs = activeCandidate;
              }
            }
            if (activeWs && activeWs.files) {
              Object.values(activeWs.files).forEach(f => {
                this._filesMap.set(f.path, {
                  path: f.path,
                  name: f.name,
                  is_dir: !!f.is_dir,
                  size: f.size || 0,
                  content: f.content !== undefined ? f.content : ""
                });
              });
            }
          } else {
            // Joining peer: receive all files from the workspace
            this._syncFilesFromMap();
          }
        }
      });

      // Liveness fallback for sync
      setTimeout(() => {
        if (this._filesMap && this._filesMap.size > 0) {
          this._syncFilesFromMap();
        }
      }, 1000);

      const currentFile = this.editorManager?.getActiveFile() || "";
      this._presenceProvider.awareness.setLocalStateField("user", {
        name: this.user.name,
        color: this.user.color,
        role: this.role,
        file: currentFile
      });

      this._presenceProvider.awareness.on("change", () => {
        const states = [];
        this._presenceProvider.awareness.getStates().forEach((state, clientId) => {
          states.push({
            clientId,
            isLocal: clientId === this._presenceProvider.awareness.clientID,
            ...state
          });
        });
        this._handleAwarenessPeers(states);
      });
    } catch (err) {
      console.warn("[FriKode] Static presence relay error:", err);
    }
  }

  _syncFilesFromMap() {
    if (!this._filesMap || this._filesMap.size === 0) return;
    const remoteFiles = {};
    this._filesMap.forEach((meta, path) => {
      remoteFiles[path] = {
        path,
        name: meta.name || path.split("/").pop(),
        is_dir: !!meta.is_dir,
        size: meta.size || 0,
        content: meta.content !== undefined ? meta.content : undefined
      };
    });

    // Update session workspace in local WorkspaceStore so it persists without bleeding
    let activeWs = null;
    if (this.session?.session_code) {
      activeWs = this.workspaceStore.getWorkspaceByCode(this.session.session_code);
    }
    if (!activeWs) {
      const activeCandidate = this.workspaceStore.getActiveWorkspace();
      if (activeCandidate && (!this.session?.session_code || activeCandidate.session_code === this.session.session_code)) {
        activeWs = activeCandidate;
      }
    }
    if (!activeWs && this.session?.session_code) {
      activeWs = this.workspaceStore.createWorkspace(
        this.session.workspace_name || `Session ${this.session.session_code}`,
        "blank",
        this.session.session_code,
        remoteFiles
      );
    }
    if (activeWs) {
      activeWs.files = remoteFiles;
      this.workspaceStore.saveWorkspace(activeWs);
    }

    this.treeData = this.workspaceStore.toTree(remoteFiles);
    this._renderFileTree();

    // If no tab is currently open, open default or teammate's active file
    if (!this.editorManager?.activePath && this.treeData.length > 0) {
      this._openDefaultFile();
    }
  }

  // -------------------------------------------------------------
  // Joining Flow
  // -------------------------------------------------------------
  openJoinModal() {
    const nameInput = document.getElementById("joinNameInput");
    if (nameInput) {
      const stored = safeGetStorage("frikode_name", "");
      nameInput.value = (stored && stored !== "Developer") ? stored : "Guest_" + Math.floor(100 + Math.random() * 900);
    }
    // Assign a distinct color for joining so it doesn't collide with host
    this.user.color = getRandomColor();
    safeSetStorage("frikode_color", this.user.color);
    if (this.editorManager) {
      this.editorManager.setUser(this.user.name, this.user.color);
    }
    document.getElementById("joinFeedbackBox").style.display = "none";

    const isGitHubPages = window.location.hostname.endsWith("github.io");
    const isRemote = window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";
    const helper = document.getElementById("joinRemoteHelper");
    const label = document.getElementById("joinRemoteHostLabel");
    const hostInput = document.getElementById("joinHostInput");

    const urlParams = new URLSearchParams(window.location.search);
    const codeParam = urlParams.get("code") || urlParams.get("session") || urlParams.get("room");

    // Pre-fill active session code or remote link
    if (codeParam) {
      hostInput.value = codeParam;
      if (helper && label) {
        helper.style.display = "block";
        label.textContent = `Invite Code: ${codeParam}`;
      }
    } else if (this.session?.session_code) {
      hostInput.value = this.session.session_code;
      if (helper && label) {
        helper.style.display = "block";
        const code = this.session.session_code;
        const wsName = this.session.workspace_name || "Workspace";
        label.textContent = `${code} (${wsName})`;
      }
    } else if (isGitHubPages) {
      hostInput.value = "";
      hostInput.placeholder = "e.g. FRI-W49Q or https://...pinggy.link";
      if (helper && label) {
        helper.style.display = "block";
        label.textContent = "Enter 6-letter Session Code (for Web workspaces) or full Remote Tunnel link (for Python/CLI host)";
      }
    } else if (isRemote) {
      hostInput.value = window.location.origin;
      if (helper && label) {
        helper.style.display = "block";
        label.textContent = window.location.origin;
      }
    } else if (helper) {
      helper.style.display = "none";
    }

    this.openModal("joinModal");
    setTimeout(() => {
      if (nameInput) nameInput.focus();
    }, 150);
  }

  async testJoinPing() {
    const rawInput = document.getElementById("joinHostInput").value.trim();
    const feedback = document.getElementById("joinFeedbackBox");
    feedback.style.display = "block";

    const isGitHubPages = window.location.hostname.endsWith("github.io");
    const isCode = !rawInput || (/^(FRI-)?[A-Za-z0-9]{4,8}$/i.test(rawInput) && !rawInput.includes(".") && !rawInput.includes(":") && !rawInput.includes("/"));
    let targetUrl;

    if (isCode) {
      const cleanCode = rawInput 
        ? (rawInput.toUpperCase().startsWith("FRI-") ? rawInput.toUpperCase() : `FRI-${rawInput.toUpperCase()}`)
        : (this.session?.session_code || "FRI-PEER");

      if (isGitHubPages || !api.baseUrl) {
        feedback.style.background = "rgba(16, 185, 129, 0.15)";
        feedback.style.color = "#6ee7b7";
        feedback.textContent = `✓ Session code "${cleanCode}" valid! Click 'Connect & Join' below to join in-browser collaboration.`;
        return;
      }
      targetUrl = window.location.origin;
    } else {
      targetUrl = this._normalizeAddress(rawInput);
    }

    feedback.style.background = "rgba(34, 211, 238, 0.1)";
    feedback.style.color = "#7dd3fc";
    feedback.textContent = `Testing connection to ${targetUrl}...`;

    try {
      const pingRes = await api.ping(targetUrl);
      const isRemotePing = !targetUrl.includes("127.0.0.1") && !targetUrl.includes("localhost") && !targetUrl.includes("192.168.");
      const label = isRemotePing ? "Remote Ping" : "Local Ping";
      feedback.style.background = "rgba(16, 185, 129, 0.15)";
      feedback.style.color = "#6ee7b7";
      feedback.textContent = `✓ Reachable! ${label}: ${pingRes.rtt}ms • Project: "${pingRes.workspace_name}" (Code: ${pingRes.session_code})`;
    } catch (err) {
      feedback.style.background = "rgba(244, 63, 94, 0.15)";
      feedback.style.color = "#fda4af";
      feedback.textContent = `✕ Could not reach host at ${targetUrl}. Check your URL or network connection.`;
    }
  }

  async confirmJoin() {
    const btn = document.getElementById("btnConfirmJoin");
    const origHtml = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span>Connecting...</span>`;
    }

    try {
      const rawInput = document.getElementById("joinHostInput").value.trim();
      const nameInput = document.getElementById("joinNameInput").value.trim() || "Participant";

      const isGitHubPages = window.location.hostname.endsWith("github.io");
      const isCode = !rawInput || (/^(FRI-)?[A-Za-z0-9]{4,8}$/i.test(rawInput) && !rawInput.includes(".") && !rawInput.includes(":") && !rawInput.includes("/"));
      let targetUrl;

      if (isCode) {
        const cleanCode = rawInput 
          ? (rawInput.toUpperCase().startsWith("FRI-") ? rawInput.toUpperCase() : `FRI-${rawInput.toUpperCase()}`)
          : (this.session?.session_code || "FRI-PEER");

        this.user.name = nameInput;
        safeSetStorage("frikode_name", nameInput);
        this.role = "participant";

        // If on GitHub Pages or standalone static web mode:
        // Connect to the room directly without needing a local Python server!
        if (this._isStaticMode()) {
          let ws = this.workspaceStore.getWorkspaceByCode(cleanCode);
          if (!ws) {
            ws = this.workspaceStore.createWorkspace(`Session ${cleanCode}`, "blank", cleanCode, {});
          } else {
            this.workspaceStore.setActiveId(ws.id);
          }

          this.session = {
            session_code: cleanCode,
            workspace_name: ws.name,
            role: "participant",
            primary_ip: "web",
            port: 4000
          };

          this.editorManager?.setUser(this.user.name, this.user.color);
          this.editorManager?.setRole("participant");
          this.editorManager?.setSessionCode(cleanCode);
          this.closeModal("joinModal");
          await this.enterWorkspace();
          showToast(`Joined session "${cleanCode}" as ${this.user.name}!`, "success");
          return;
        }

        targetUrl = window.location.origin;
        if (rawInput && this.session?.session_code) {
          const cleanEntered = rawInput.toUpperCase().replace(/^FRI-/, "");
          const cleanActual = this.session.session_code.toUpperCase().replace(/^FRI-/, "");
          if (cleanEntered !== cleanActual) {
            showToast(`Session code "${rawInput.toUpperCase()}" does not match active session (${this.session.session_code})`, "error");
            return;
          }
        }
      } else {
        targetUrl = this._normalizeAddress(rawInput);
      }

      this.user.name = nameInput;
      safeSetStorage("frikode_name", nameInput);
      this.role = "participant";

      // If targetUrl is the current origin, use relative requests (empty baseUrl) to prevent CORS and URL issues
      if (targetUrl === window.location.origin || targetUrl === "" || targetUrl === "/") {
        api.setBaseUrl("");
      } else {
        api.setBaseUrl(targetUrl);
      }

      try {
        this.session = await api.getSession();
        api.setSessionCode(this.session.session_code);
        let ws = this.workspaceStore.getWorkspaceByCode(this.session.session_code);
        if (!ws) {
          ws = this.workspaceStore.createWorkspace(this.session.workspace_name || `Session ${this.session.session_code}`, "blank", this.session.session_code, {});
        } else {
          this.workspaceStore.setActiveId(ws.id);
        }
      } catch (err) {
        showToast(`Cannot connect to host: ${err.message || targetUrl}`, "error");
        return;
      }

      this.editorManager?.setUser(this.user.name, this.user.color);
      this.editorManager?.setRole("participant");
      this.editorManager?.setSessionCode(this.session.session_code);
      this.closeModal("joinModal");
      await this.enterWorkspace();
    } catch (err) {
      console.error("Error confirming join:", err);
      showToast("Failed to join: " + (err.message || err), "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    }
  }

  // -------------------------------------------------------------
  // Workspace Setup & Collaboration
  // -------------------------------------------------------------
  async enterWorkspace() {
    this.switchView("workspaceView");

    // Clean up any stale tabs from previous workspace session
    this.editorManager?.closeAllTabs();

    // Update Topbar UI
    document.getElementById("topbarProjectName").textContent = this.session?.workspace_name || "Workspace";
    const roleBadge = document.getElementById("topbarRoleBadge");
    roleBadge.textContent = this.role === "host" ? "Host" : "Peer";
    roleBadge.className = `badge-role ${this.role === "host" ? "host" : "peer"}`;

    document.getElementById("topbarSessionCode").textContent = this.session?.session_code || "FRI-....";
    document.getElementById("topbarAddress").textContent = this._getInviteUrl();

    document.getElementById("statusRoleLabel").textContent = this.role === "host" ? "Host (Workspace Owner)" : "Participant (Guest)";
    document.getElementById("leaveText").textContent = this.role === "host" ? "End Session" : "Leave";

    this._updateUserProfileButton();

    if (this._isStaticMode()) {
      const sessionCode = this.session?.session_code || "FRI-PEER";
      this._connectStaticPresence(sessionCode);
    } else {
      // Connect Signaling WebSocket safely
      try {
        this._connectSignaling();
      } catch (wsErr) {
        console.warn("Signaling initialization warning:", wsErr);
      }
    }

    // Load workspace files safely
    try {
      await this.loadFiles();
    } catch (fileErr) {
      console.warn("Load files warning:", fileErr);
    }

    // Start network health ping
    this._startPingMonitor();

    // Open README.md or first available file by default
    setTimeout(() => {
      this._openDefaultFile();
    }, 200);

    showToast(`Entered FriKode workspace as ${this.user.name}!`, "success");
  }

  _openDefaultFile() {
    if (!this.treeData || this.treeData.length === 0) {
      this.editorManager?.closeAllTabs();
      return;
    }

    // If joining a session where a teammate is already active on a file, join their file
    if (this.role === "participant" && this.peers.length > 0) {
      const activePeer = this.peers.find(p => !p.isLocal && p.active_file);
      if (activePeer && activePeer.active_file) {
        this.editorManager.openFile(activePeer.active_file);
        return;
      }
    }

    // Look for main.py, index.html, or first code file
    const findNode = (items) => {
      for (const item of items) {
        if (!item.is_dir) {
          if (item.name.toLowerCase() === "main.py" || item.name.toLowerCase() === "index.html" || item.name.toLowerCase() === "readme.md") {
            return item;
          }
        }
        if (item.children) {
          const found = findNode(item.children);
          if (found) return found;
        }
      }
      return null;
    };

    let targetNode = findNode(this.treeData);
    if (!targetNode && this.treeData.length > 0) {
      // Pick first non-directory
      const pickFirst = (items) => {
        for (const item of items) {
          if (!item.is_dir) return item;
          if (item.children) {
            const p = pickFirst(item.children);
            if (p) return p;
          }
        }
        return null;
      };
      targetNode = pickFirst(this.treeData);
    }

    if (targetNode) {
      let initial = null;
      if (this.role !== "participant") {
        if (targetNode.content !== undefined && targetNode.content !== null) {
          initial = targetNode.content;
        } else {
          const activeWs = this.session?.session_code ? this.workspaceStore.getWorkspaceByCode(this.session.session_code) : this.workspaceStore.getActiveWorkspace();
          if (activeWs && activeWs.files && activeWs.files[targetNode.path]) {
            initial = activeWs.files[targetNode.path].content;
          }
        }
      }
      this.editorManager.openFile(targetNode.path, initial);
    }
  }

  async loadFiles() {
    // 1. Identify active workspace in WorkspaceStore for THIS specific session
    let activeWs = null;
    if (this.session?.session_code) {
      activeWs = this.workspaceStore.getWorkspaceByCode(this.session.session_code);
    }
    if (!activeWs) {
      const activeCandidate = this.workspaceStore.getActiveWorkspace();
      if (activeCandidate && (!this.session?.session_code || activeCandidate.session_code === this.session.session_code)) {
        activeWs = activeCandidate;
      }
    }

    if (!activeWs) {
      const wsName = this.session?.workspace_name || `Workspace ${this.session?.session_code || "New"}`;
      const tpl = this.session?.template || (this.role === "participant" ? "blank" : "python");
      activeWs = this.workspaceStore.createWorkspace(wsName, tpl, this.session?.session_code, {});
    }

    this.workspaceStore.setActiveId(activeWs.id);

    // 2. If the workspace is explicitly blank with zero files, keep it completely blank!
    if ((activeWs.template === "blank" || this.session?.template === "blank") && (!activeWs.files || Object.keys(activeWs.files).length === 0)) {
      if (this.session) {
        this.session.workspace_name = activeWs.name;
        this.session.session_code = this.session.session_code || activeWs.session_code;
        const titleEl = document.getElementById("topbarProjectName");
        if (titleEl) titleEl.textContent = activeWs.name;
      }
      this.treeData = [];
      this._renderFileTree();
      this.editorManager?.closeAllTabs();
      return;
    }

    const isStandaloneStatic = this._isStaticMode();
    if (!isStandaloneStatic) {
      try {
        const res = await api.getFiles(this.session?.session_code);
        if (res && res.tree && res.tree.length > 0) {
          this.treeData = res.tree;
          this._renderFileTree();
          return;
        }
      } catch (err) {
        console.warn("Backend file fetch skipped/fallback:", err);
      }
    }

    if (this.session) {
      this.session.workspace_name = activeWs.name;
      this.session.session_code = this.session.session_code || activeWs.session_code;
      const titleEl = document.getElementById("topbarProjectName");
      if (titleEl) titleEl.textContent = activeWs.name;
    }
    this.treeData = this.workspaceStore.toTree(activeWs.files);
    this._renderFileTree();
  }

  _loadDemoWorkspace() {
    this.treeData = [
      {
        path: "main.py",
        name: "main.py",
        is_dir: false,
        size: 380,
        content: `# FriKode • Collaborative Code Editor
# Real-Time CRDT Sync with Zero Cloud Servers

import sys

def main():
    print("Welcome to FriKode Live Web Demo!")
    print("1. Edit any file in the workspace.")
    print("2. Press Cmd/Ctrl + Enter to run code.")
    print("3. Click 'Join' above to connect to any live host.")

if __name__ == "__main__":
    main()
`
      },
      {
        path: "app.js",
        name: "app.js",
        is_dir: false,
        size: 320,
        content: `// FriKode In-Browser JavaScript Sandbox
function calculateStats(a, b) {
  const sum = a + b;
  const product = a * b;
  console.log("Calculated sum:", sum);
  console.log("Calculated product:", product);
  return { sum, product };
}

calculateStats(42, 108);
`
      },
      {
        path: "style.css",
        name: "style.css",
        is_dir: false,
        size: 210,
        content: `/* FriKode MailerBot Industrial Palette */
:root {
  --canvas-bg: #fffefc;
  --canvas-border: #dad1c5;
  --accent-lime: #e9ffa3;
  --text-black: #050505;
}
`
      },
      {
        path: "README.md",
        name: "README.md",
        is_dir: false,
        size: 490,
        content: `# FriKode Web Preview

You are currently viewing FriKode hosted live on GitHub Pages!

### Available in this Web Preview:
- **Interactive Code Editor**: Syntax highlighting, line numbers, and live editing.
- **In-Browser Execution**: Run JavaScript code directly in the sandbox console.
- **Remote Host Connection**: Click **Join** in the navigation bar to connect to any live FriKode host over Wi-Fi or Remote Tunnel.
`
      }
    ];

    this._renderFileTree();
    this.editorManager.openFile("main.py", this.treeData[0].content);
  }

  _renderFileTree() {
    const container = document.getElementById("fileTreeContainer");
    container.innerHTML = "";

    const renderNodes = (nodes, parentEl, level = 0) => {
      nodes.forEach(node => {
        const itemEl = document.createElement("div");
        itemEl.className = "tree-node";

        const rowEl = document.createElement("div");
        rowEl.className = `tree-item ${this.editorManager?.activePath === node.path ? "active" : ""}`;
        rowEl.style.paddingLeft = `${12 + level * 14}px`;

        if (node.is_dir) {
          const isCollapsed = this.collapsedFolders.has(node.path);
          const icon = isCollapsed ? Icons.chevronRight : Icons.chevronDown;
          rowEl.innerHTML = `
            <span class="node-icon" style="color: #64748b;">${icon}</span>
            <span class="node-icon" style="color: #94a3b8;">${isCollapsed ? Icons.folder : Icons.folderOpen}</span>
            <span class="node-name">${node.name}</span>
          `;
          rowEl.onclick = () => {
            if (isCollapsed) this.collapsedFolders.delete(node.path);
            else this.collapsedFolders.add(node.path);
            this._renderFileTree();
          };
          itemEl.appendChild(rowEl);

          if (!isCollapsed && node.children) {
            const childrenContainer = document.createElement("div");
            renderNodes(node.children, childrenContainer, level + 1);
            itemEl.appendChild(childrenContainer);
          }
        } else {
          const fileInfo = getFileIcon(node.name);
          
          // Check if any peer is currently in this file
          const peersInFile = this.peers.filter(p => p.active_file === node.path);
          let presenceDotsHtml = "";
          if (peersInFile.length > 0) {
            presenceDotsHtml = `
              <div class="node-presence-dots" title="${peersInFile.map(p => p.name).join(", ")} editing this file">
                ${peersInFile.map(p => `<span class="presence-mini-dot" style="background-color: ${p.color};"></span>`).join("")}
              </div>
            `;
          }

          rowEl.innerHTML = `
            <span class="node-icon" style="color: ${fileInfo.color}">${fileInfo.icon}</span>
            <span class="node-name">${node.name}</span>
            ${presenceDotsHtml}
          `;

          rowEl.onclick = () => {
            let initial = null;
            if (this.role !== "participant") {
              if (node.content !== undefined && node.content !== null) {
                initial = node.content;
              } else {
                const activeWs = this.session?.session_code ? this.workspaceStore.getWorkspaceByCode(this.session.session_code) : this.workspaceStore.getActiveWorkspace();
                if (activeWs && activeWs.files && activeWs.files[node.path]) {
                  initial = activeWs.files[node.path].content;
                }
              }
            }
            this.editorManager.openFile(node.path, initial);
            this._renderFileTree();
            this.toggleMobileSidebar(false);
          };

          // Context action on right click or hover
          rowEl.oncontextmenu = (e) => {
            e.preventDefault();
            this.openDeleteModal(node.path);
          };

          itemEl.appendChild(rowEl);
        }

        parentEl.appendChild(itemEl);
      });
    };

    if (this.treeData.length === 0) {
      container.innerHTML = `
        <div style="padding: 24px 14px; color: var(--text-muted); font-size: 12px; text-align: center; line-height: 1.5;">
          <div style="font-size: 20px; margin-bottom: 6px;">📂</div>
          <strong style="color: var(--text-dark);">Workspace is empty</strong><br>
          Click <strong>+</strong> or <strong>Import Folder</strong> to add files.
        </div>
      `;
    } else {
      renderNodes(this.treeData, container);
    }
  }

  // -------------------------------------------------------------
  // Signaling & Presence
  // -------------------------------------------------------------
  _connectSignaling() {
    if (this.signalingWs) {
      this.signalingWs.close();
    }

    if (this._isStaticMode()) {
      document.getElementById("reconnectingBanner").style.display = "none";
      return;
    }

    let baseHost = window.location.host;
    let protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

    if (api.baseUrl) {
      try {
        const parsed = new URL(api.baseUrl);
        baseHost = parsed.host;
        protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      } catch (_) {}
    }

    const wsUrl = `${protocol}//${baseHost}/ws/collaboration`;
    this.signalingWs = new WebSocket(wsUrl);

    this.signalingWs.onopen = () => {
      document.getElementById("reconnectingBanner").style.display = "none";
      // Send join announcement
      this.signalingWs.send(JSON.stringify({
        type: "join",
        id: this.user.id,
        name: this.user.name,
        color: this.user.color,
        role: this.role
      }));
    };

    this.signalingWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleSignalingMessage(msg);
      } catch (err) {
        console.error("Signaling message parse error:", err);
      }
    };

    this.signalingWs.onclose = () => {
      console.warn("Signaling WebSocket disconnected.");
      document.getElementById("reconnectingBanner").style.display = "flex";
      // Auto-reconnect
      setTimeout(() => {
        if (document.getElementById("workspaceView").classList.contains("active")) {
          this._connectSignaling();
        }
      }, 3000);
    };

    this.signalingWs.onerror = (err) => {
      console.error("Signaling WebSocket error:", err);
    };
  }

  _handleSignalingMessage(msg) {
    switch (msg.type) {
      case "peers_update":
        this.peers = msg.peers || [];
        // Sync our role if changed by host or server
        const myPeer = this.peers.find(p => p.id === this.user.id);
        if (myPeer && myPeer.role && myPeer.role !== this.role) {
          this.role = myPeer.role;
        }
        this._renderPeers();
        this._renderFileTree();
        break;

      case "host_transferred":
        if (msg.target_id === this.user.id) {
          this.role = "host";
          showToast("You are now the Session Host!", "success");
          this._addActivity("Host position was transferred to you");
        } else if (this.role === "host") {
          this.role = "participant";
          showToast(`Host position transferred to ${msg.new_host_name}`, "info");
        } else {
          showToast(`Host position transferred to ${msg.new_host_name}`, "info");
        }
        this._updateUserProfileButton();
        break;

      case "peer_joined":
        if (msg.peer && msg.peer.id !== this.user.id) {
          showToast(`${msg.peer.name} joined the session!`, "info");
          this._addActivity(`${msg.peer.name} joined the room`);
        }
        break;

      case "peer_left":
        if (msg.peer) {
          showToast(`${msg.peer.name} left the session.`, "info");
          this._addActivity(`${msg.peer.name} left`);
        }
        break;

      case "file_saved":
        if (msg.path) {
          showToast(`${msg.path} saved to host by ${msg.saved_by}`, "success");
          this._addActivity(`${msg.saved_by} saved ${msg.path}`);
        }
        break;

      case "tree_updated":
        this.loadFiles();
        break;

      case "session_ended":
        this.openModal("sessionEndedModal");
        if (msg.reason) {
          document.getElementById("sessionEndedReason").textContent = msg.reason;
        }
        break;

      case "workspace_reset":
        this.loadFiles();
        showToast("Host switched workspace", "info");
        break;

      case "tunnel_update":
        if (msg.tunnel) {
          this._updateTunnelUI(msg.tunnel);
        }
        break;

      case "code_executed":
        if (msg.user_name) {
          const statusTxt = msg.status === "success" ? "ran successfully" : (msg.status === "compile_error" ? "compile error" : "failed");
          this._addActivity(`${msg.user_name} ran ${msg.file} (${statusTxt})`);
        }
        break;
    }
  }

  _notifyFileFocus(filePath) {
    if (this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
      this.signalingWs.send(JSON.stringify({
        type: "file_focus",
        file: filePath
      }));
    }
  }

  _renderPeers() {
    const stack = document.getElementById("topbarCollaborators");
    const list = document.getElementById("peersList");
    const countEl = document.getElementById("statusPeersCount");

    stack.innerHTML = "";
    list.innerHTML = "";
    countEl.textContent = `${this.peers.length} Collaborator${this.peers.length === 1 ? "" : "s"}`;

    this.peers.forEach(peer => {
      const isYou = peer.id === this.user.id;
      const initial = (peer.name || "P")[0].toUpperCase();
      const isHost = peer.role === "host";

      // Avatar pill in topbar with immediate hover tooltip displaying name & role
      const avatar = document.createElement("div");
      avatar.className = "collaborator-avatar";
      avatar.style.backgroundColor = peer.color || "#22d3ee";
      avatar.innerHTML = `
        <span>${initial}</span>
        <div class="avatar-tooltip">
          <div class="avatar-tooltip-header">
            <span class="avatar-tooltip-name">${peer.name}${isYou ? " (You)" : ""}</span>
            <span class="avatar-tooltip-badge ${peer.role}">${isHost ? "HOST" : "PEER"}</span>
          </div>
          <div class="avatar-tooltip-sub">${peer.active_file ? "Editing " + peer.active_file : "Active in workspace"}</div>
        </div>
      `;
      avatar.onclick = () => {
        if (isYou) {
          this.openProfileModal();
        } else if (this.role === "host") {
          this.openProfileModal(peer.id);
        } else {
          showToast(`${peer.name} (${peer.role})`, "info");
        }
      };
      stack.appendChild(avatar);

      // List item in activity drawer
      const listItem = document.createElement("div");
      listItem.className = "peer-list-item";
      listItem.innerHTML = `
        <span class="peer-color-dot" style="background-color: ${peer.color};"></span>
        <div class="peer-info">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="peer-name">${peer.name} ${isYou ? "(You)" : ""}</span>
            <span class="badge-role ${peer.role}" style="font-size: 9px; padding: 1px 5px;">${isHost ? "HOST" : "PEER"}</span>
          </div>
          <span class="peer-file">${peer.active_file ? "Editing: " + peer.active_file : "Browsing files"}</span>
        </div>
        <div class="peer-actions">
          ${isYou 
            ? `<button class="peer-mini-btn" title="Change name or position" data-action="edit-profile">Edit</button>` 
            : (this.role === "host" ? `<button class="peer-mini-btn lime" title="Make Host" data-action="make-host" data-id="${peer.id}">Make Host</button>` : "")
          }
        </div>
      `;

      const editBtn = listItem.querySelector('[data-action="edit-profile"]');
      if (editBtn) {
        editBtn.onclick = () => this.openProfileModal();
      }
      const makeHostBtn = listItem.querySelector('[data-action="make-host"]');
      if (makeHostBtn) {
        makeHostBtn.onclick = () => this.transferHostPosition(peer.id, peer.name);
      }

      list.appendChild(listItem);
    });

    this._updateUserProfileButton();
  }

  _updateUserProfileButton() {
    const dot = document.getElementById("userProfileDot");
    const nameEl = document.getElementById("userProfileName");
    const roleBadge = document.getElementById("userProfileRoleBadge");
    const tooltipName = document.getElementById("userTooltipName");
    const tooltipRole = document.getElementById("userTooltipRole");

    const initial = (this.user.name || "D")[0].toUpperCase();
    if (dot) {
      dot.style.backgroundColor = this.user.color;
      dot.textContent = initial;
    }
    if (nameEl) {
      nameEl.textContent = this.user.name;
    }
    const isHost = this.role === "host";
    if (roleBadge) {
      roleBadge.textContent = isHost ? "Host" : "Peer";
      roleBadge.className = `badge-role ${isHost ? "host" : "peer"}`;
    }
    if (tooltipName) {
      tooltipName.textContent = `${this.user.name} (You)`;
    }
    if (tooltipRole) {
      tooltipRole.textContent = isHost ? "HOST" : "PEER";
      tooltipRole.className = `avatar-tooltip-badge ${isHost ? "host" : "peer"}`;
    }

    const topbarRole = document.getElementById("topbarRoleBadge");
    if (topbarRole) {
      topbarRole.textContent = isHost ? "Host" : "Peer";
      topbarRole.className = `badge-role ${isHost ? "host" : "peer"}`;
    }
    const statusRole = document.getElementById("statusRoleLabel");
    if (statusRole) {
      statusRole.textContent = isHost ? "Host (Workspace Owner)" : "Participant (Guest)";
    }
    const leaveText = document.getElementById("leaveText");
    if (leaveText) {
      leaveText.textContent = isHost ? "End Session" : "Leave";
    }
  }

  openProfileModal(preselectPeerId = null) {
    const nameInput = document.getElementById("profileNameInput");
    if (nameInput) {
      nameInput.value = this.user.name || "Developer";
    }

    this._initColorSwatches("profileColorSwatches");

    const radioHost = document.getElementById("radioRoleHost");
    const radioPeer = document.getElementById("radioRolePeer");
    const cardHost = document.getElementById("cardRoleHost");
    const cardPeer = document.getElementById("cardRolePeer");

    if (this.role === "host") {
      if (radioHost) radioHost.checked = true;
      if (cardHost) cardHost.classList.add("selected");
      if (cardPeer) cardPeer.classList.remove("selected");
    } else {
      if (radioPeer) radioPeer.checked = true;
      if (cardPeer) cardPeer.classList.add("selected");
      if (cardHost) cardHost.classList.remove("selected");
    }

    const transferSection = document.getElementById("transferHostSection");
    const transferSelect = document.getElementById("transferHostSelect");
    const otherPeers = this.peers.filter(p => p.id !== this.user.id);

    if (transferSection && transferSelect) {
      if (otherPeers.length > 0) {
        transferSection.style.display = "flex";
        transferSelect.innerHTML = `<option value="">Select a collaborator...</option>` +
          otherPeers.map(p => `<option value="${p.id}" ${p.id === preselectPeerId ? "selected" : ""}>${p.name} (${p.role})</option>`).join("");
      } else {
        transferSection.style.display = "none";
      }
    }

    this.openModal("profileModal");
    setTimeout(() => {
      if (nameInput) nameInput.focus();
    }, 100);
  }

  confirmSaveProfile() {
    const nameInput = document.getElementById("profileNameInput");
    const newName = (nameInput?.value || "").trim() || this.user.name;
    const selectedRadio = document.querySelector('input[name="profileRoleOption"]:checked');
    const newRole = selectedRadio ? selectedRadio.value : this.role;

    this.updateProfile(newName, this.user.color, newRole);
  }

  confirmTransferHostFromModal() {
    const select = document.getElementById("transferHostSelect");
    const targetId = select?.value;
    if (!targetId) {
      showToast("Please choose a collaborator to transfer host to.", "error");
      return;
    }
    const targetPeer = this.peers.find(p => p.id === targetId);
    const targetName = targetPeer ? targetPeer.name : "collaborator";
    this.closeModal("profileModal");
    this.transferHostPosition(targetId, targetName);
  }

  transferHostPosition(targetId, targetName) {
    if (!confirm(`Are you sure you want to transfer the Host position to ${targetName}?`)) {
      return;
    }
    if (this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
      this.signalingWs.send(JSON.stringify({
        type: "transfer_host",
        target_id: targetId
      }));
      showToast(`Transferring host position to ${targetName}...`, "info");
    }
  }

  updateProfile(newName, newColor, newRole) {
    newName = (newName || "").trim() || this.user.name;
    newColor = newColor || this.user.color;

    this.user.name = newName;
    this.user.color = newColor;
    safeSetStorage("frikode_name", newName);
    safeSetStorage("frikode_color", newColor);

    if (newRole && newRole !== this.role) {
      this.role = newRole;
    }

    // Update editor CRDT awareness
    if (this.editorManager) {
      this.editorManager.setUser(this.user.name, this.user.color);
    }

    // Broadcast over WebSocket signaling
    if (this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
      this.signalingWs.send(JSON.stringify({
        type: "update_profile",
        name: this.user.name,
        color: this.user.color,
        role: this.role
      }));
    }

    this._updateUserProfileButton();
    showToast("Profile updated!", "success");
    this.closeModal("profileModal");
  }

  _addActivity(text) {
    const feed = document.getElementById("activityFeed");
    const item = document.createElement("div");
    item.className = "activity-item";
    const timeStr = formatTime(Date.now() / 1000);
    item.innerHTML = `
      <div>${text}</div>
      <div class="activity-time">${timeStr}</div>
    `;
    feed.prepend(item);
  }

  // -------------------------------------------------------------
  // File Creation & Deletion
  // -------------------------------------------------------------
  openCreateEntryModal(type) {
    this.pendingCreateType = type;
    document.getElementById("createEntryModalTitle").textContent = type === "folder" ? "Create Folder" : "Create File";
    const input = document.getElementById("createEntryInput");
    input.value = "";
    input.placeholder = type === "folder" ? "e.g. components" : "e.g. script.js";
    this.openModal("createEntryModal");
    setTimeout(() => input.focus(), 100);
  }

  async confirmCreateEntry() {
    const name = document.getElementById("createEntryInput").value.trim();
    if (!name) {
      showToast("Please enter a name", "error");
      return;
    }

    const isFolder = this.pendingCreateType === "folder";
    const isStandaloneStatic = this._isStaticMode();

    if (!isStandaloneStatic) {
      try {
        await api.createFile(name, isFolder);
        this.closeModal("createEntryModal");
        await this.loadFiles();
        if (!isFolder) {
          this.editorManager.openFile(name);
        }
        showToast(`Created ${name}`, "success");
        return;
      } catch (err) {
        console.warn("Backend createFile failed/skipped, saving to local workspace:", err);
      }
    }

    // In-browser workspace store
    const activeWs = this.workspaceStore.getActiveWorkspace();
    if (activeWs) {
      if (!activeWs.files) activeWs.files = {};
      activeWs.files[name] = {
        path: name,
        name: name.split("/").pop(),
        is_dir: isFolder,
        size: 0,
        content: ""
      };
      this.workspaceStore.saveWorkspace(activeWs);

      // Broadcast to shared static workspace presence room so all peers see the new file
      if (this._filesMap) {
        this._filesMap.set(name, {
          path: name,
          name: name.split("/").pop(),
          is_dir: isFolder,
          size: 0
        });
      }

      this.closeModal("createEntryModal");
      await this.loadFiles();
      if (!isFolder) {
        this.editorManager.openFile(name, "");
      }
      showToast(`Created ${name}`, "success");
    }
  }

  openDeleteModal(path) {
    this.pendingDeletePath = path;
    document.getElementById("deleteConfirmText").textContent = `Are you sure you want to delete "${path}"?`;
    this.openModal("deleteConfirmModal");
  }

  async confirmDeleteEntry() {
    if (!this.pendingDeletePath) return;

    const isStandaloneStatic = this._isStaticMode();

    if (!isStandaloneStatic) {
      try {
        await api.deleteFile(this.pendingDeletePath);
        this.editorManager.closeTab(this.pendingDeletePath);
        this.closeModal("deleteConfirmModal");
        await this.loadFiles();
        showToast(`Deleted ${this.pendingDeletePath}`, "success");
        return;
      } catch (err) {
        console.warn("Backend deleteFile failed/skipped, removing from local workspace:", err);
      }
    }

    const activeWs = this.workspaceStore.getActiveWorkspace();
    if (activeWs && activeWs.files) {
      delete activeWs.files[this.pendingDeletePath];
      this.workspaceStore.saveWorkspace(activeWs);

      // Broadcast deletion to shared static presence room
      if (this._filesMap) {
        this._filesMap.delete(this.pendingDeletePath);
      }

      this.editorManager.closeTab(this.pendingDeletePath);
      this.closeModal("deleteConfirmModal");
      await this.loadFiles();
      showToast(`Deleted ${this.pendingDeletePath}`, "success");
    }
  }

  // -------------------------------------------------------------
  // Session Exit
  // -------------------------------------------------------------
  async leaveSession() {
    const doLeave = () => {
      if (this._presenceProvider) {
        try {
          this._presenceProvider.destroy();
        } catch (_) {}
        this._presenceProvider = null;
      }
      this.editorManager?.closeAllTabs();
      if (this.signalingWs) this.signalingWs.close();
      this.session = null;
      api.setSessionCode(null);
      this.switchView("homeView");
    };

    if (this.role === "host") {
      if (confirm("End this FriKode session for all participants?")) {
        try {
          await api.endSession();
        } catch (_) {}
        doLeave();
      }
    } else {
      if (confirm("Leave this collaborative session?")) {
        doLeave();
      }
    }
  }

  // -------------------------------------------------------------
  // Remote Access & Tunnel Management
  // -------------------------------------------------------------
  async openRemoteModal() {
    this.openModal("remoteModal");
    const isStandaloneStatic = this._isStaticMode();
    if (isStandaloneStatic) {
      const inviteUrl = this._getInviteUrl();
      this._updateTunnelUI({
        active: true,
        url: inviteUrl,
        provider: "Web / GitHub Pages",
        error: null
      });
      const modalStatusDesc = document.getElementById("modalRemoteStatusDesc");
      if (modalStatusDesc) {
        modalStatusDesc.textContent = "You are running FriKode in the browser! Your workspace connects via global WebSocket relay. Anyone worldwide can join using your direct link below.";
      }
      return;
    }
    try {
      const tunnel = await api.getTunnel();
      this._updateTunnelUI(tunnel);
    } catch (err) {
      console.warn("Could not fetch tunnel status:", err);
    }
  }

  async toggleTunnel() {
    const isStandaloneStatic = this._isStaticMode();
    if (isStandaloneStatic) {
      const inviteUrl = this._getInviteUrl();
      this._updateTunnelUI({
        active: true,
        url: inviteUrl,
        provider: "Web / GitHub Pages",
        error: null
      });
      copyToClipboard(inviteUrl, "Remote collaboration link copied!");
      showToast("Web collaboration link ready! Share with teammates.", "success");
      return;
    }

    const btnAction = document.getElementById("btnToggleTunnelAction");
    const btnText = document.getElementById("btnToggleTunnelText");
    const origText = btnText ? btnText.textContent : "";
    if (btnAction) btnAction.disabled = true;

    try {
      if (this.tunnelActive) {
        if (btnText) btnText.textContent = "Stopping...";
        const res = await api.stopTunnel();
        this._updateTunnelUI(res);
        showToast("Remote access turned off", "info");
      } else {
        if (btnText) btnText.textContent = "Starting...";
        const provider = document.getElementById("selectTunnelProvider")?.value || "auto";
        let res;
        try {
          res = await api.startTunnel(provider);
        } catch (apiErr) {
          console.warn("Tunnel start API error, checking status fallback:", apiErr);
          res = await api.getTunnel().catch(() => ({ active: false, error: apiErr.message }));
        }
        this._updateTunnelUI(res);
        if (res && res.active && res.url) {
          showToast("Remote link ready! Share the link with teammates.", "success");
        } else if (res && res.error) {
          showToast(`Tunnel notice: ${res.error}`, "info");
        } else {
          showToast("Could not establish tunnel. You can enter a custom URL below or check internet.", "info");
        }
      }
    } catch (err) {
      console.error("Tunnel toggle error:", err);
      showToast("Tunnel error: " + (err.message || err), "error");
      if (btnText) btnText.textContent = origText;
    } finally {
      if (btnAction) btnAction.disabled = false;
    }
  }

  copyRemoteLink() {
    const url = document.getElementById("modalRemoteUrlInput")?.value || this.tunnelUrl;
    if (url) {
      copyToClipboard(url, "Remote link copied to clipboard!");
    } else {
      showToast("No active remote link to copy", "info");
    }
  }

  copyInviteMessage() {
    const url = this.tunnelUrl || this._getInviteUrl();
    const code = this.session?.session_code || "FRI-....";
    const wsName = this.session?.workspace_name || "Workspace";
    const isRemote = !!this.tunnelUrl || (window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1");
    const msg = [
      `🚀 Join my FriKode session: "${wsName}"`,
      `🔑 Session Code: ${code}`,
      `🌐 Link (${isRemote ? "Remote / Internet" : "Local Wi-Fi"}): ${url}`
    ].join("\n");
    copyToClipboard(msg, "Complete invite message copied!");
  }

  async applyCustomTunnelUrl() {
    const input = document.getElementById("customTunnelUrlInput");
    const url = input?.value?.trim();
    if (!url) {
      showToast("Please enter a valid URL (e.g. https://yourname.ngrok.app)", "error");
      return;
    }
    const isStandaloneStatic = this._isStaticMode();
    if (isStandaloneStatic) {
      this._updateTunnelUI({
        active: true,
        url: url,
        provider: "custom",
        error: null
      });
      showToast("Custom remote URL applied!", "success");
      if (input) input.value = "";
      return;
    }
    try {
      const res = await api.setCustomTunnelUrl(url);
      this._updateTunnelUI(res);
      showToast("Custom remote URL applied!", "success");
      if (input) input.value = "";
    } catch (err) {
      showToast("Failed to apply custom URL: " + (err.message || err), "error");
    }
  }

  _updateTunnelUI(tunnel) {
    if (!tunnel) return;
    this.tunnelActive = !!tunnel.active;
    this.tunnelUrl = tunnel.url || null;

    if (tunnel.url) {
      if (this.session) this.session.public_url = tunnel.url;
      const topbarAddr = document.getElementById("topbarAddress");
      if (topbarAddr) topbarAddr.textContent = tunnel.url;
      const homeIpBadge = document.getElementById("homeLocalIpBadge");
      if (homeIpBadge) homeIpBadge.textContent = `Remote Link: ${tunnel.url}`;
      const publicRow = document.getElementById("modalHostPublicRow");
      if (publicRow) publicRow.style.display = "flex";
      const publicAddr = document.getElementById("modalHostPublicAddress");
      if (publicAddr) publicAddr.textContent = tunnel.url;
    }

    // Topbar Beacon & Label
    const topbarBeacon = document.getElementById("topbarRemoteBeacon");
    const topbarText = document.getElementById("topbarRemoteText");
    if (topbarBeacon) {
      if (tunnel.active) {
        topbarBeacon.classList.add("active");
      } else {
        topbarBeacon.classList.remove("active");
      }
    }
    if (topbarText) {
      if (tunnel.active) {
        topbarText.textContent = "Remote: Active";
      } else {
        topbarText.textContent = "Remote Access";
      }
    }

    // Modal Status Beacon, Title & Description
    const modalBeacon = document.getElementById("modalRemoteBeacon");
    const modalStatusText = document.getElementById("modalRemoteStatusText");
    const modalStatusDesc = document.getElementById("modalRemoteStatusDesc");

    if (modalBeacon) {
      if (tunnel.active) {
        modalBeacon.className = "remote-beacon active";
      } else {
        modalBeacon.className = "remote-beacon";
      }
    }

    if (modalStatusText) {
      if (tunnel.active) {
        const provLabel = tunnel.provider === "cloudflare" ? "Cloudflare" : (tunnel.provider === "pinggy" ? "Pinggy" : "Public Link");
        modalStatusText.textContent = `Remote Active (${provLabel})`;
      } else if (tunnel.error) {
        modalStatusText.textContent = `Remote Failed`;
      } else {
        modalStatusText.textContent = `Local Wi-Fi Only`;
      }
    }

    if (modalStatusDesc) {
      if (tunnel.active) {
        modalStatusDesc.textContent = "Secure remote tunnel is active! Anyone on another Wi-Fi or mobile hotspot can join with your public link.";
      } else if (tunnel.error) {
        modalStatusDesc.textContent = `Could not start tunnel: ${tunnel.error}. You can also set a custom URL or try a different provider below.`;
      } else {
        modalStatusDesc.textContent = "Enable remote access to generate a secure public link for friends on other Wi-Fi networks or mobile data.";
      }
    }

    // Action button text and styling
    const btnAction = document.getElementById("btnToggleTunnelAction");
    const btnText = document.getElementById("btnToggleTunnelText");
    if (btnText && btnAction) {
      if (tunnel.active) {
        btnText.textContent = "Stop Remote Link";
        btnAction.className = "mbot-btn mbot-btn-tan";
      } else {
        btnText.textContent = "Start Remote Link";
        btnAction.className = "mbot-btn mbot-btn-lime";
      }
    }

    // URL input and section
    const urlSection = document.getElementById("remoteUrlSection");
    const urlInput = document.getElementById("modalRemoteUrlInput");
    if (urlSection && urlInput) {
      if (tunnel.active && tunnel.url) {
        urlSection.style.display = "block";
        urlInput.value = tunnel.url;
      } else {
        urlSection.style.display = "none";
        urlInput.value = "";
      }
    }

    // Host modal checkbox sync
    const hostCheckbox = document.getElementById("hostEnableTunnelCheckbox");
    if (hostCheckbox) {
      hostCheckbox.checked = !!tunnel.active;
    }
  }

  // -------------------------------------------------------------
  // In-Browser Compiler & Code Execution
  // -------------------------------------------------------------
  _detectLanguage(path, code = "") {
    if (path) {
      const ext = path.split(".").pop().toLowerCase();
      if (ext === "py") return "python";
      if (ext === "c" || ext === "h") return "c";
      if (ext === "cpp" || ext === "cc" || ext === "cxx" || ext === "hpp") return "cpp";
      if (ext === "js" || ext === "mjs" || ext === "cjs") return "javascript";
      if (ext === "html" || ext === "htm") return "html";
      if (ext === "rs") return "rust";
      if (ext === "sh" || ext === "bash") return "bash";
      if (ext === "java") return "java";
      if (ext === "go") return "go";
      if (ext === "ts" || ext === "tsx") return "typescript";
      if (ext === "php") return "php";
      if (ext === "rb") return "ruby";
    }
    const c = (code || "").toLowerCase();
    if (c.includes("#include <iostream>") || c.includes("std::cout")) return "cpp";
    if (c.includes("#include <stdio.h>") || c.includes("printf(")) return "c";
    if (c.includes("fn main()") || c.includes("println!(")) return "rust";
    if (c.includes("package main") && c.includes("func main(")) return "go";
    if (c.includes("public class ") && c.includes("static void main")) return "java";
    if (c.includes("<!doctype html") || c.includes("<html") || c.includes("<body")) return "html";
    if (c.includes("console.log") || c.includes("document.") || c.includes("window.")) return "javascript";
    if (c.includes("echo ") || c.includes("#!/bin/")) return "bash";
    return "python";
  }

  // -------------------------------------------------------------
  // Multi-Language Compiler & In-Browser Code Execution Engine
  // -------------------------------------------------------------
  async runCurrentCode(withStdin = false) {
    if (!this.editorManager) return;
    const activePath = this.editorManager.activePath;
    const currentCode = this.editorManager.getValue();

    if (!activePath && !currentCode.trim()) {
      showToast("Open or create a file to run code", "info");
      return;
    }

    // Auto-save active file before running if path exists
    if (activePath) {
      this.editorManager.saveCurrentFile();
    }

    // Ensure compiler panel is open
    this.toggleCompilerPanel(true);

    const btnRun = document.getElementById("btnRunCode");
    const runText = document.getElementById("runBtnText");
    const beacon = document.getElementById("compilerBeacon");
    const statusBadge = document.getElementById("compilerStatusBadge");
    const pre = document.getElementById("compilerOutputPre");
    const statusDot = document.getElementById("statusConsoleDot");
    const stdinInput = document.getElementById("compilerStdinInput");

    const stdinVal = withStdin && stdinInput ? stdinInput.value : (stdinInput?.value || "");

    if (btnRun) btnRun.classList.add("running");
    if (runText) runText.textContent = "Running...";
    if (beacon) beacon.className = "compiler-beacon running";
    if (statusBadge) {
      statusBadge.className = "compiler-badge status running";
      statusBadge.textContent = "Compiling & Running...";
    }
    if (statusDot) statusDot.className = "status-mini-dot running";

    const fileName = activePath ? activePath.split("/").pop() : "snippet";
    const timestamp = new Date().toLocaleTimeString();
    const lang = this._detectLanguage(activePath, currentCode);

    const compilerLangEl = document.getElementById("compilerLangBadge");
    if (compilerLangEl) compilerLangEl.textContent = lang.toUpperCase();

    // Append launch header to output
    const startNotice = `\n[${timestamp}] ▶ Running ${fileName} (${lang.toUpperCase()})...\n` + "─".repeat(45) + "\n";
    pre.innerHTML += `<span class="output-system">${this._escapeHtml(startNotice)}</span>`;
    pre.scrollTop = pre.scrollHeight;

    const isStandaloneStatic = this._isStaticMode();

    // If running in standalone static web mode (GitHub Pages), execute directly in browser or cloud compiler!
    if (isStandaloneStatic) {
      try {
        await this._executeLanguage(lang, currentCode, stdinVal, pre, statusBadge, beacon, statusDot);
      } finally {
        if (btnRun) btnRun.classList.remove("running");
        if (runText) runText.textContent = "Run";
        pre.scrollTop = pre.scrollHeight;
      }
      return;
    }

    try {
      const res = await api.runCode({
        path: activePath,
        code: currentCode,
        stdin: stdinVal,
        userName: this.user.name
      });

      // If language was deferred to client execution engine
      if (res.client_eval) {
        if (res.stderr) {
          pre.innerHTML += `<span class="output-dim">${this._escapeHtml(res.stderr)}\n</span>`;
        }
        await this._executeLanguage(lang, currentCode, stdinVal, pre, statusBadge, beacon, statusDot);
      } else {
        // Output stdout if any
        if (res.stdout) {
          pre.innerHTML += `<span class="output-stdout">${this._escapeHtml(res.stdout)}</span>`;
          if (!res.stdout.endsWith("\n")) pre.innerHTML += "\n";
        }

        // Output stderr if any
        if (res.stderr) {
          pre.innerHTML += `<span class="output-stderr">${this._escapeHtml(res.stderr)}</span>`;
          if (!res.stderr.endsWith("\n")) pre.innerHTML += "\n";
        }

        // Output summary status
        if (res.status === "success") {
          pre.innerHTML += `<span class="output-success">✓ Process finished with exit code ${res.exit_code} (${res.duration_ms}ms)\n</span>`;
          if (statusBadge) {
            statusBadge.className = "compiler-badge status success";
            statusBadge.textContent = `Exit: ${res.exit_code} (${res.duration_ms}ms)`;
          }
          if (beacon) beacon.className = "compiler-beacon success";
          if (statusDot) statusDot.className = "status-mini-dot active";
        } else if (res.status === "compile_error") {
          pre.innerHTML += `<span class="output-stderr">✕ Compilation failed (${res.duration_ms}ms)\n</span>`;
          if (statusBadge) {
            statusBadge.className = "compiler-badge status error";
            statusBadge.textContent = `Compile Error (${res.duration_ms}ms)`;
          }
          if (beacon) beacon.className = "compiler-beacon error";
          if (statusDot) statusDot.className = "status-mini-dot";
        } else if (res.status === "timeout") {
          pre.innerHTML += `<span class="output-stderr">✕ Execution timed out (${res.duration_ms}ms)\n</span>`;
          if (statusBadge) {
            statusBadge.className = "compiler-badge status error";
            statusBadge.textContent = "Timeout";
          }
          if (beacon) beacon.className = "compiler-beacon error";
          if (statusDot) statusDot.className = "status-mini-dot";
        } else {
          pre.innerHTML += `<span class="output-stderr">✕ Process exited with code ${res.exit_code} (${res.duration_ms}ms)\n</span>`;
          if (statusBadge) {
            statusBadge.className = "compiler-badge status error";
            statusBadge.textContent = `Exit: ${res.exit_code} (${res.duration_ms}ms)`;
          }
          if (beacon) beacon.className = "compiler-beacon error";
          if (statusDot) statusDot.className = "status-mini-dot";
        }
      }
    } catch (err) {
      pre.innerHTML += `<span class="output-dim">Host connection offline/unavailable. Switching to cloud execution runner...\n</span>`;
      await this._executeLanguage(lang, currentCode, stdinVal, pre, statusBadge, beacon, statusDot);
    } finally {
      if (btnRun) btnRun.classList.remove("running");
      if (runText) runText.textContent = "Run";
      pre.scrollTop = pre.scrollHeight;
    }
  }

  async _executeLanguage(lang, code, stdinVal, pre, statusBadge, beacon, statusDot) {
    if (lang === "python") {
      await this._runPythonInBrowser(code, stdinVal, pre, statusBadge, beacon, statusDot);
    } else if (lang === "javascript") {
      this._runJavaScriptInBrowser(code, pre, statusBadge, beacon, statusDot);
    } else if (lang === "html") {
      this._runHtmlPreview(code, pre, statusBadge, beacon, statusDot);
    } else if (lang === "c") {
      await this._runWithWandbox("gcc-head-c", code, stdinVal, pre, statusBadge, beacon, statusDot, "C (GCC)");
    } else if (lang === "cpp") {
      await this._runWithWandbox("gcc-head", code, stdinVal, pre, statusBadge, beacon, statusDot, "C++ (GCC)");
    } else if (lang === "rust") {
      await this._runWithWandbox("rust-1.82.0", code, stdinVal, pre, statusBadge, beacon, statusDot, "Rust");
    } else if (lang === "bash") {
      await this._runWithWandbox("bash", code, stdinVal, pre, statusBadge, beacon, statusDot, "Bash");
    } else if (lang === "java") {
      await this._runWithWandbox("openjdk-jdk-22+36", code, stdinVal, pre, statusBadge, beacon, statusDot, "Java");
    } else if (lang === "go") {
      await this._runWithWandbox("go-1.23.2", code, stdinVal, pre, statusBadge, beacon, statusDot, "Go");
    } else if (lang === "typescript") {
      await this._runWithWandbox("typescript-5.6.2", code, stdinVal, pre, statusBadge, beacon, statusDot, "TypeScript");
    } else if (lang === "php") {
      await this._runWithWandbox("php-8.3.12", code, stdinVal, pre, statusBadge, beacon, statusDot, "PHP");
    } else if (lang === "ruby") {
      await this._runWithWandbox("ruby-4.0.2", code, stdinVal, pre, statusBadge, beacon, statusDot, "Ruby");
    } else {
      await this._runWithWandbox("gcc-head", code, stdinVal, pre, statusBadge, beacon, statusDot, lang.toUpperCase());
    }
  }

  async _runWithWandbox(compiler, code, stdinVal, pre, statusBadge, beacon, statusDot, langName = "Compiler") {
    const startTime = performance.now();
    pre.innerHTML += `<span class="output-dim">[${langName} Engine] Compiling & executing with ${compiler}...\n</span>`;
    pre.scrollTop = pre.scrollHeight;

    try {
      const payload = {
        compiler: compiler,
        code: code,
        stdin: stdinVal || ""
      };

      const res = await fetch("https://wandbox.org/api/compile.json", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        throw new Error(`Compiler service returned HTTP ${res.status}`);
      }

      const data = await res.json();
      const elapsed = Math.round(performance.now() - startTime);

      // Compiler warnings or errors
      const compErr = data.compiler_error || data.compiler_message;
      if (compErr && compErr.trim()) {
        pre.innerHTML += `<span class="output-stderr">${this._escapeHtml(compErr.trim())}\n</span>`;
      }

      // Program stdout
      const progOut = data.program_output || data.program_message;
      if (progOut) {
        pre.innerHTML += `<span class="output-stdout">${this._escapeHtml(progOut)}</span>`;
        if (!progOut.endsWith("\n")) pre.innerHTML += "\n";
      }

      // Program stderr
      const progErr = data.program_error;
      if (progErr && progErr !== progOut) {
        pre.innerHTML += `<span class="output-stderr">${this._escapeHtml(progErr)}</span>`;
        if (!progErr.endsWith("\n")) pre.innerHTML += "\n";
      }

      const exitCode = parseInt(data.status, 10);
      const isOk = exitCode === 0 && !data.signal;

      if (isOk) {
        pre.innerHTML += `<span class="output-success">✓ Process finished with exit code 0 (${elapsed}ms)\n</span>`;
        if (statusBadge) {
          statusBadge.className = "compiler-badge status success";
          statusBadge.textContent = `${langName} (${elapsed}ms)`;
        }
        if (beacon) beacon.className = "compiler-beacon success";
        if (statusDot) statusDot.className = "status-mini-dot active";
      } else {
        const errorDesc = data.signal ? `Terminated by signal ${data.signal}` : `Process exited with code ${data.status || 1}`;
        pre.innerHTML += `<span class="output-stderr">✕ ${errorDesc} (${elapsed}ms)\n</span>`;
        if (statusBadge) {
          statusBadge.className = "compiler-badge status error";
          statusBadge.textContent = `Exit ${data.status || 1} (${elapsed}ms)`;
        }
        if (beacon) beacon.className = "compiler-beacon error";
        if (statusDot) statusDot.className = "status-mini-dot";
      }
    } catch (err) {
      const elapsed = Math.round(performance.now() - startTime);
      pre.innerHTML += `<span class="output-stderr">✕ Compilation runner failed: ${this._escapeHtml(err.message || String(err))}\n</span>`;
      if (statusBadge) {
        statusBadge.className = "compiler-badge status error";
        statusBadge.textContent = "Error";
      }
      if (beacon) beacon.className = "compiler-beacon error";
      if (statusDot) statusDot.className = "status-mini-dot";
    } finally {
      pre.scrollTop = pre.scrollHeight;
    }
  }

  _runHtmlPreview(htmlCode, pre, statusBadge, beacon, statusDot) {
    const startTime = performance.now();
    pre.innerHTML += `<span class="output-dim">[Web Live Preview Engine] Rendering HTML/CSS/JS in interactive sandbox...\n</span>`;
    
    const frameId = "htmlPreviewFrame_" + Date.now();
    pre.innerHTML += `
      <div class="html-live-preview-box" style="margin: 8px 0; border: 1px solid #444; border-radius: 6px; overflow: hidden; background: #fff;">
        <div style="background: #1e1e1e; color: #888; padding: 4px 10px; font-size: 11px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333;">
          <span style="font-weight: 600; color: #cbd5e1;">🌐 Live Web Preview</span>
          <button id="btnOpenNewTabPreview_${frameId}" style="background: #2d3748; color: #e2e8f0; border: 1px solid #4a5568; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer;">Open in New Tab ↗</button>
        </div>
        <iframe id="${frameId}" sandbox="allow-scripts allow-modals" style="width: 100%; height: 260px; border: none; background: #fff;"></iframe>
      </div>
    `;

    setTimeout(() => {
      const frame = document.getElementById(frameId);
      if (frame) {
        const doc = frame.contentDocument || frame.contentWindow.document;
        doc.open();
        doc.write(htmlCode);
        doc.close();
      }
      const newTabBtn = document.getElementById(`btnOpenNewTabPreview_${frameId}`);
      if (newTabBtn) {
        newTabBtn.onclick = () => {
          const blob = new Blob([htmlCode], { type: "text/html" });
          const url = URL.createObjectURL(blob);
          window.open(url, "_blank");
        };
      }
    }, 60);

    const elapsed = Math.round(performance.now() - startTime);
    pre.innerHTML += `<span class="output-success">✓ Rendered web preview successfully (${elapsed}ms)\n</span>`;
    if (statusBadge) {
      statusBadge.className = "compiler-badge status success";
      statusBadge.textContent = `HTML Preview (${elapsed}ms)`;
    }
    if (beacon) beacon.className = "compiler-beacon success";
    if (statusDot) statusDot.className = "status-mini-dot active";
    pre.scrollTop = pre.scrollHeight;
  }

  async _runPythonInBrowser(code, stdinVal, pre, statusBadge, beacon, statusDot) {
    const startTime = performance.now();
    pre.innerHTML += `<span class="output-dim">[Python WebAssembly Engine] Initializing in-browser Python runtime...\n</span>`;
    pre.scrollTop = pre.scrollHeight;

    try {
      if (!window._pyodideInstance) {
        if (!window.loadPyodide) {
          await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js";
            script.onload = resolve;
            script.onerror = () => reject(new Error("Could not load Python WebAssembly runtime from CDN. Check your internet connection."));
            document.head.appendChild(script);
          });
        }
        window._pyodideInstance = await window.loadPyodide();
      }

      const pyodide = window._pyodideInstance;
      const stdoutBuf = [];
      const stderrBuf = [];

      pyodide.setStdout({ batched: (msg) => stdoutBuf.push(msg) });
      pyodide.setStderr({ batched: (msg) => stderrBuf.push(msg) });

      if (stdinVal) {
        const stdinLines = stdinVal.split("\n");
        let stdinIndex = 0;
        pyodide.setStdin({
          stdin: () => {
            if (stdinIndex < stdinLines.length) {
              return stdinLines[stdinIndex++];
            }
            return "";
          }
        });
      }

      await pyodide.runPythonAsync(code);

      const elapsed = Math.round(performance.now() - startTime);
      const out = stdoutBuf.join("\n");
      const err = stderrBuf.join("\n");

      if (out) {
        pre.innerHTML += `<span class="output-stdout">${this._escapeHtml(out)}\n</span>`;
      }
      if (err) {
        pre.innerHTML += `<span class="output-stderr">${this._escapeHtml(err)}\n</span>`;
      }

      pre.innerHTML += `<span class="output-success">✓ Process finished with exit code 0 (${elapsed}ms)\n</span>`;
      if (statusBadge) {
        statusBadge.className = "compiler-badge status success";
        statusBadge.textContent = `Python Wasm (${elapsed}ms)`;
      }
      if (beacon) beacon.className = "compiler-beacon success";
      if (statusDot) statusDot.className = "status-mini-dot active";
    } catch (pyErr) {
      if (pyErr.message && (pyErr.message.includes("Could not load Python WebAssembly") || pyErr.message.includes("CDN"))) {
        pre.innerHTML += `<span class="output-dim">Wasm CDN unavailable, switching to Wandbox Python runner...\n</span>`;
        await this._runWithWandbox("cpython-head", code, stdinVal, pre, statusBadge, beacon, statusDot, "Python (CPython)");
        return;
      }
      const elapsed = Math.round(performance.now() - startTime);
      const errStr = pyErr.message || String(pyErr);
      pre.innerHTML += `<span class="output-stderr">${this._escapeHtml(errStr)}\n</span>`;
      if (statusBadge) {
        statusBadge.className = "compiler-badge status error";
        statusBadge.textContent = `Python Error (${elapsed}ms)`;
      }
      if (beacon) beacon.className = "compiler-beacon error";
      if (statusDot) statusDot.className = "status-mini-dot";
    } finally {
      pre.scrollTop = pre.scrollHeight;
    }
  }

  _runJavaScriptInBrowser(code, pre, statusBadge, beacon, statusDot) {
    pre.innerHTML += `<span class="output-dim">[Browser JS Engine] Running JavaScript in sandbox...\n</span>`;
    let jsLogs = [];
    const origLog = console.log;
    const origErr = console.error;
    const startTime = performance.now();
    try {
      console.log = (...args) => {
        jsLogs.push(args.map(a => typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)).join(" "));
      };
      console.error = (...args) => {
        jsLogs.push("[Error] " + args.join(" "));
      };
      const fn = new Function(code);
      fn();
      const elapsed = Math.round(performance.now() - startTime);
      const out = jsLogs.join("\n");
      if (out) pre.innerHTML += `<span class="output-stdout">${this._escapeHtml(out)}\n</span>`;
      pre.innerHTML += `<span class="output-success">✓ Executed in browser sandbox in ${elapsed}ms\n</span>`;
      if (statusBadge) {
        statusBadge.className = "compiler-badge status success";
        statusBadge.textContent = `Browser JS (${elapsed}ms)`;
      }
      if (beacon) beacon.className = "compiler-beacon success";
      if (statusDot) statusDot.className = "status-mini-dot active";
    } catch (evalErr) {
      pre.innerHTML += `<span class="output-stderr">Runtime Error: ${this._escapeHtml(evalErr.message)}\n</span>`;
      if (statusBadge) {
        statusBadge.className = "compiler-badge status error";
        statusBadge.textContent = "Error";
      }
      if (beacon) beacon.className = "compiler-beacon error";
      if (statusDot) statusDot.className = "status-mini-dot";
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }


  toggleCompilerPanel(forceOpen = null) {
    const panel = document.getElementById("compilerPanel");
    const statusBtn = document.getElementById("btnToggleConsoleStatus");
    if (!panel) return;
    const isCollapsed = panel.classList.contains("collapsed");
    const shouldOpen = forceOpen !== null ? forceOpen : isCollapsed;
    if (shouldOpen) {
      panel.classList.remove("collapsed");
      if (statusBtn) statusBtn.classList.add("active");
    } else {
      panel.classList.add("collapsed");
      panel.classList.remove("maximized");
      if (statusBtn) statusBtn.classList.remove("active");
    }
  }

  toggleCompilerMaximize() {
    const panel = document.getElementById("compilerPanel");
    if (!panel) return;
    panel.classList.remove("collapsed");
    panel.classList.toggle("maximized");
    const isMax = panel.classList.contains("maximized");
    const maxIcon = document.getElementById("compilerMaxIcon");
    if (maxIcon) {
      maxIcon.innerHTML = isMax ? Icons.minimize : Icons.maximize;
    }
  }

  clearCompilerOutput() {
    const pre = document.getElementById("compilerOutputPre");
    if (pre) {
      pre.innerHTML = `<span class="output-dim">Console cleared. Ready for next run.</span>\n`;
    }
  }

  toggleStdinBar() {
    const bar = document.getElementById("compilerStdinBar");
    if (!bar) return;
    const isOpen = bar.style.display !== "none";
    bar.style.display = isOpen ? "none" : "flex";
    if (!isOpen) {
      document.getElementById("compilerStdinInput")?.focus();
    }
  }

  // -------------------------------------------------------------
  // Mobile Navigation & Responsive Drawer Helpers
  // -------------------------------------------------------------
  toggleMobileNav() {
    const links = document.getElementById("landingNavLinks");
    const actions = document.getElementById("landingHeaderActions");
    if (links) links.classList.toggle("mobile-open");
    if (actions) actions.classList.toggle("mobile-open");
  }

  toggleMobileSidebar(forceOpen = null) {
    const sidebar = document.getElementById("sidebar");
    const backdrop = document.getElementById("sidebarBackdrop");
    if (!sidebar) return;
    const isCurrentlyOpen = sidebar.classList.contains("mobile-open");
    const shouldOpen = forceOpen !== null ? forceOpen : !isCurrentlyOpen;
    if (shouldOpen) {
      sidebar.classList.add("mobile-open");
      if (backdrop) backdrop.classList.add("active");
    } else {
      sidebar.classList.remove("mobile-open");
      if (backdrop) backdrop.classList.remove("active");
    }
  }

  _escapeHtml(text) {
    if (!text) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // -------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------
  _updateNetworkUI() {
    const isGitHubPages = window.location.hostname.endsWith("github.io");
    const isRemote = window.location.hostname !== "localhost" && 
                     window.location.hostname !== "127.0.0.1" && 
                     window.location.hostname !== "";
    const port = this.session?.port || window.location.port || 4000;
    const ip = this.session?.primary_ip || (isRemote ? window.location.hostname : "127.0.0.1");
    const fullWifiUrl = `http://${ip}:${port}`;
    const publicUrl = this.session?.public_url || (isRemote && !isGitHubPages ? window.location.origin : null);

    const homeBadge = document.getElementById("homeLocalIpBadge");
    if (homeBadge) {
      if (isGitHubPages) {
        homeBadge.textContent = "GitHub Pages • In-Browser Workspaces & Real-Time Collaboration";
      } else if (publicUrl) {
        homeBadge.textContent = `Remote Link: ${publicUrl}`;
      } else if (this.session && this.session.primary_ip) {
        homeBadge.textContent = `Wi-Fi Address: ${fullWifiUrl}`;
      } else {
        homeBadge.textContent = isRemote 
          ? `Host: ${window.location.origin}` 
          : `Local Host: http://${window.location.host || `localhost:${port}`}`;
      }
    }

    // Modal Host Addresses
    const publicRow = document.getElementById("modalHostPublicRow");
    const publicAddr = document.getElementById("modalHostPublicAddress");
    if (publicUrl) {
      if (publicRow) publicRow.style.display = "flex";
      if (publicAddr) publicAddr.textContent = publicUrl;
    } else {
      if (publicRow) publicRow.style.display = "none";
      if (publicAddr) publicAddr.textContent = "Inactive (Local Wi-Fi Only)";
    }

    const modalWifi = document.getElementById("modalHostWifiAddress");
    if (modalWifi) {
      modalWifi.textContent = fullWifiUrl;
    }

    const modalCode = document.getElementById("modalHostSessionCode");
    if (modalCode) {
      modalCode.textContent = this.session?.session_code || "FRI-READY";
    }

    // Set buttons to Create Workspace & Join Workspace
    const btnJoin = document.getElementById("btnOpenJoinModal");
    if (btnJoin) {
      btnJoin.innerHTML = `<span>Join Workspace</span>`;
      btnJoin.className = "mbot-btn mbot-btn-tan";
      btnJoin.onclick = () => this.openJoinModal();
    }
    const btnHost = document.getElementById("btnOpenHostModal");
    if (btnHost) {
      btnHost.innerHTML = `<span>Create Workspace</span>
        <span class="mbot-arrow-track" aria-hidden="true">
          <svg viewBox="0 0 21 12" fill="none" class="mbot-arrow-svg primary"><path d="M20.0303 6.05328C20.3232 5.76039 20.3232 5.28551 20.0303 4.99262L15.2574 0.219648C14.9645 -0.073245 14.4896 -0.073245 14.1967 0.219648C13.9038 0.512542 13.9038 0.987415 14.1967 1.28031L18.4393 5.52295L14.1967 9.76559C13.9038 10.0585 13.9038 10.5334 14.1967 10.8263C14.4896 11.1191 14.9645 11.1191 15.2574 10.8263L20.0303 6.05328ZM0 5.52295V6.27295H19.5V5.52295V4.77295H0V5.52295Z" fill="currentColor"></path></svg>
          <svg viewBox="0 0 21 12" fill="none" class="mbot-arrow-svg clone"><path d="M20.0303 6.05328C20.3232 5.76039 20.3232 5.28551 20.0303 4.99262L15.2574 0.219648C14.9645 -0.073245 14.4896 -0.073245 14.1967 0.219648C13.9038 0.512542 13.9038 0.987415 14.1967 1.28031L18.4393 5.52295L14.1967 9.76559C13.9038 10.0585 13.9038 10.5334 14.1967 10.8263C14.4896 11.1191 14.9645 11.1191 15.2574 10.8263L20.0303 6.05328ZM0 5.52295V6.27295H19.5V5.52295V4.77295H0V5.52295Z" fill="currentColor"></path></svg>
        </span>`;
      btnHost.className = "mbot-btn mbot-btn-lime";
      btnHost.onclick = () => this.openHostModal();
    }
    const btnNavJoin = document.getElementById("btnNavJoin");
    if (btnNavJoin) {
      btnNavJoin.innerHTML = `<span>Join Workspace</span>`;
      btnNavJoin.className = "mbot-btn mbot-btn-tan";
      btnNavJoin.onclick = () => this.openJoinModal();
    }
    const btnNavHost = document.getElementById("btnNavHost");
    if (btnNavHost) {
      btnNavHost.innerHTML = `<span>Create Workspace</span>
        <span class="mbot-arrow-track" aria-hidden="true">
          <svg viewBox="0 0 21 12" fill="none" class="mbot-arrow-svg primary"><path d="M20.0303 6.05328C20.3232 5.76039 20.3232 5.28551 20.0303 4.99262L15.2574 0.219648C14.9645 -0.073245 14.4896 -0.073245 14.1967 0.219648C13.9038 0.512542 13.9038 0.987415 14.1967 1.28031L18.4393 5.52295L14.1967 9.76559C13.9038 10.0585 13.9038 10.5334 14.1967 10.8263C14.4896 11.1191 14.9645 11.1191 15.2574 10.8263L20.0303 6.05328ZM0 5.52295V6.27295H19.5V5.52295V4.77295H0V5.52295Z" fill="currentColor"></path></svg>
          <svg viewBox="0 0 21 12" fill="none" class="mbot-arrow-svg clone"><path d="M20.0303 6.05328C20.3232 5.76039 20.3232 5.28551 20.0303 4.99262L15.2574 0.219648C14.9645 -0.073245 14.4896 -0.073245 14.1967 0.219648C13.9038 0.512542 13.9038 0.987415 14.1967 1.28031L18.4393 5.52295L14.1967 9.76559C13.9038 10.0585 13.9038 10.5334 14.1967 10.8263C14.4896 11.1191 14.9645 11.1191 15.2574 10.8263L20.0303 6.05328ZM0 5.52295V6.27295H19.5V5.52295V4.77295H0V5.52295Z" fill="currentColor"></path></svg>
        </span>`;
      btnNavHost.className = "mbot-btn mbot-btn-lime";
      btnNavHost.onclick = () => this.openHostModal();
    }
  }

  _getInviteUrl() {
    if (this.tunnelUrl) return this.tunnelUrl;
    if (this.session?.public_url) return this.session.public_url;
    const isGitHubPages = window.location.hostname.endsWith("github.io");
    if (isGitHubPages) {
      const code = this.session?.session_code || "FRI-READY";
      const base = window.location.origin + window.location.pathname;
      return `${base}?room=${code}`;
    }
    if (!this.session) return window.location.origin;
    const isRemote = window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";
    if (isRemote) return window.location.origin;
    const ip = this.session.primary_ip || window.location.hostname;
    const port = this.session.port || window.location.port || 4000;
    return `http://${ip}:${port}`;
  }

  _normalizeAddress(raw) {
    if (!raw) return window.location.origin;
    let cleaned = raw.trim();
    if (!cleaned) return window.location.origin;

    // Check if session code was entered (e.g. FRI-CDU9 or CDU9)
    const isCode = /^(FRI-)?[A-Za-z0-9]{4,8}$/i.test(cleaned) && !cleaned.includes(".") && !cleaned.includes(":") && !cleaned.includes("/");
    if (isCode) {
      return window.location.origin;
    }

    if (!cleaned.startsWith("http://") && !cleaned.startsWith("https://")) {
      if (cleaned.includes(":") || cleaned.includes("localhost") || /^(\d{1,3}\.){3}\d{1,3}/.test(cleaned)) {
        cleaned = cleaned.includes(":") ? `http://${cleaned}` : `http://${cleaned}:4000`;
      } else {
        cleaned = `https://${cleaned}`;
      }
    }
    return cleaned.replace(/\/$/, "");
  }

  _startPingMonitor() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this._isStaticMode()) {
      const pingText = document.getElementById("statusPingText");
      if (pingText) pingText.textContent = `Live Web Demo`;
      return;
    }
    this.pingInterval = setInterval(async () => {
      try {
        const ping = await api.ping();
        const isRemote = window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";
        const label = (this.session?.public_url || isRemote) ? "Remote / Cloud" : "Local Wi-Fi";
        document.getElementById("statusPingText").textContent = `${label} • Ping: ${ping.rtt}ms`;
      } catch (_) {
        document.getElementById("statusPingText").textContent = `Disconnected`;
      }
    }, 10000);
  }
}

// Instantiate on DOM ready or immediately if already loaded
function initApp() {
  if (!window.frikodeApp) {
    window.frikodeApp = new FriKodeApp();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}

