/**
 * FriKode Application Controller
 * Handles view switching, session management, file tree, signaling, and presence.
 */

import { api } from "./api.js";
import { EditorManager } from "./editor.js";
import { Icons, getFileIcon } from "./icons.js";
import { ACCENT_COLORS, getRandomColor, copyToClipboard, showToast, formatTime } from "./utils.js";

class FriKodeApp {
  constructor() {
    this.session = null;
    this.role = "host"; // "host" or "participant"
    this.user = {
      id: "user_" + Math.random().toString(36).substring(2, 9),
      name: localStorage.getItem("frikode_name") || "Developer",
      color: localStorage.getItem("frikode_color") || getRandomColor()
    };

    this.editorManager = null;
    this.signalingWs = null;
    this.peers = [];
    this.treeData = [];
    this.collapsedFolders = new Set();
    this.pingInterval = null;

    // Pending file action state (for modals)
    this.pendingCreateType = "file"; // "file" or "folder"
    this.pendingDeletePath = null;

    this.init();
  }

  async init() {
    this._injectIcons();
    this._initColorSwatches();
    this._bindEvents();
    this._initEditor();

    // Check if running on a live FriKode host
    try {
      this.session = await api.getSession();
      this._updateNetworkUI();
    } catch (err) {
      console.warn("Could not reach local session API immediately:", err);
    }
  }

  _injectIcons() {
    document.getElementById("wifiIcon").innerHTML = Icons.wifi;
    document.getElementById("hostIconBadge").innerHTML = Icons.laptop;
    document.getElementById("joinIconBadge").innerHTML = Icons.users;
    document.getElementById("saveIcon").innerHTML = Icons.save;
    document.getElementById("activityIcon").innerHTML = Icons.activity;
    document.getElementById("newFileIcon").innerHTML = Icons.plus;
    document.getElementById("newFolderIcon").innerHTML = Icons.folder;
    document.getElementById("refreshIcon").innerHTML = Icons.refresh;
    document.getElementById("modalHostIcon").innerHTML = Icons.laptop;
    document.getElementById("modalJoinIcon").innerHTML = Icons.users;
    document.getElementById("modalCopyIcon").innerHTML = Icons.copy;
    document.getElementById("modalCopyCodeIcon").innerHTML = Icons.copy;
    document.getElementById("topbarCopyIcon").innerHTML = Icons.copy;
    document.getElementById("closeActivityIcon").innerHTML = Icons.close;
  }

  _initColorSwatches() {
    const container = document.getElementById("colorSwatches");
    container.innerHTML = "";
    ACCENT_COLORS.forEach(color => {
      const swatch = document.createElement("div");
      swatch.className = `color-swatch ${color === this.user.color ? "selected" : ""}`;
      swatch.style.backgroundColor = color;
      swatch.onclick = () => {
        container.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("selected"));
        swatch.classList.add("selected");
        this.user.color = color;
        localStorage.setItem("frikode_color", color);
        if (this.editorManager) {
          this.editorManager.setUser(this.user.name, this.user.color);
        }
      };
      container.appendChild(swatch);
    });
  }

  _initEditor() {
    this.editorManager = new EditorManager({
      onCursorChange: ({ line, col }) => {
        document.getElementById("statusCursorPos").textContent = `Ln ${line}, Col ${col}`;
      },
      onSaveStateChange: (state) => {
        const dot = document.getElementById("syncStatusDot");
        const text = document.getElementById("syncStatusText");
        dot.className = `sync-dot ${state}`;
        if (state === "synced") text.textContent = "Synced";
        else if (state === "saving") text.textContent = "Saving...";
        else if (state === "unsaved") text.textContent = "Unsaved";
        else if (state === "error") text.textContent = "Save Error";
      },
      onTabChange: (tabInfo) => {
        const langEl = document.getElementById("statusLanguage");
        if (tabInfo) {
          langEl.textContent = tabInfo.mode.toUpperCase();
          this._notifyFileFocus(tabInfo.path);
        } else {
          langEl.textContent = "Plain Text";
          this._notifyFileFocus(null);
        }
      }
    });

    this.editorManager.setUser(this.user.name, this.user.color);
  }

  _bindEvents() {
    // Home Action Cards
    document.getElementById("btnHostCard").onclick = () => this.openHostModal();
    document.getElementById("btnOpenHostModal").onclick = (e) => { e.stopPropagation(); this.openHostModal(); };
    document.getElementById("btnJoinCard").onclick = () => this.openJoinModal();
    document.getElementById("btnOpenJoinModal").onclick = (e) => { e.stopPropagation(); this.openJoinModal(); };

    // Host Modal
    document.getElementById("btnCloseHostModal").onclick = () => this.closeModal("hostModal");
    document.getElementById("btnCancelHost").onclick = () => this.closeModal("hostModal");
    document.getElementById("btnConfirmHost").onclick = () => this.confirmHost();
    document.getElementById("btnCopyModalAddress").onclick = () => {
      const addr = document.getElementById("modalHostWifiAddress").textContent;
      copyToClipboard(addr, "Wi-Fi address copied!");
    };
    document.getElementById("btnCopyModalCode").onclick = () => {
      const code = document.getElementById("modalHostSessionCode").textContent;
      copyToClipboard(code, "Session code copied!");
    };

    // Join Modal
    document.getElementById("btnCloseJoinModal").onclick = () => this.closeModal("joinModal");
    document.getElementById("btnTestJoinConnection").onclick = () => this.testJoinPing();
    document.getElementById("btnConfirmJoin").onclick = () => this.confirmJoin();

    // Top Bar Actions
    document.getElementById("btnCopyInvite").onclick = () => {
      const fullUrl = this._getInviteUrl();
      copyToClipboard(fullUrl, "Wi-Fi invite address copied!");
    };
    document.getElementById("btnSaveFile").onclick = () => {
      this.editorManager.saveCurrentFile();
    };
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
      if (e.key === "Escape") {
        document.querySelectorAll(".modal-backdrop.active").forEach(m => m.classList.remove("active"));
      }
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
    try {
      this.session = await api.getSession();
      this._updateNetworkUI();
    } catch (err) {
      console.warn("Could not refresh session info:", err);
    }
    this.openModal("hostModal");
  }

  async confirmHost() {
    const workspaceInput = document.getElementById("hostWorkspaceInput").value.trim() || "sample_project";
    try {
      const res = await api.createSession(workspaceInput, false);
      this.session.session_code = res.session_code;
      this.session.workspace_name = res.workspace_name;
    } catch (err) {
      console.error("Failed to reinitialize workspace:", err);
    }

    this.role = "host";
    this.user.name = "Host (" + (localStorage.getItem("frikode_name") || "Me") + ")";
    this.editorManager.setUser(this.user.name, this.user.color);

    this.closeModal("hostModal");
    this.enterWorkspace();
  }

  // -------------------------------------------------------------
  // Joining Flow
  // -------------------------------------------------------------
  openJoinModal() {
    const nameInput = document.getElementById("joinNameInput");
    nameInput.value = localStorage.getItem("frikode_name") || "";
    document.getElementById("joinFeedbackBox").style.display = "none";
    this.openModal("joinModal");
  }

  async testJoinPing() {
    const hostInput = document.getElementById("joinHostInput").value.trim();
    const feedback = document.getElementById("joinFeedbackBox");
    feedback.style.display = "block";

    if (!hostInput) {
      feedback.style.background = "rgba(244, 63, 94, 0.15)";
      feedback.style.color = "#fda4af";
      feedback.textContent = "Please enter the host Wi-Fi address (e.g. 192.168.1.105:4000).";
      return;
    }

    const normalizedUrl = this._normalizeAddress(hostInput);
    feedback.style.background = "rgba(34, 211, 238, 0.1)";
    feedback.style.color = "#7dd3fc";
    feedback.textContent = `Testing connection to ${normalizedUrl}...`;

    try {
      const pingRes = await api.ping(normalizedUrl);
      feedback.style.background = "rgba(16, 185, 129, 0.15)";
      feedback.style.color = "#6ee7b7";
      feedback.textContent = `✓ Reachable! Local Wi-Fi Ping: ${pingRes.rtt}ms • Project: "${pingRes.workspace_name}"`;
    } catch (err) {
      feedback.style.background = "rgba(244, 63, 94, 0.15)";
      feedback.style.color = "#fda4af";
      feedback.textContent = `✕ Could not reach host at ${normalizedUrl}. Ensure both devices are on the same Wi-Fi.`;
    }
  }

  async confirmJoin() {
    const hostInput = document.getElementById("joinHostInput").value.trim();
    const nameInput = document.getElementById("joinNameInput").value.trim() || "Participant";

    if (!hostInput) {
      showToast("Please enter the host Wi-Fi address", "error");
      return;
    }

    const normalizedUrl = this._normalizeAddress(hostInput);
    this.user.name = nameInput;
    localStorage.setItem("frikode_name", nameInput);
    this.role = "participant";

    // Set API base URL to target host
    api.setBaseUrl(normalizedUrl);

    try {
      this.session = await api.getSession();
    } catch (err) {
      showToast(`Cannot connect to host at ${normalizedUrl}`, "error");
      return;
    }

    this.editorManager.setUser(this.user.name, this.user.color);
    this.closeModal("joinModal");
    this.enterWorkspace();
  }

  // -------------------------------------------------------------
  // Workspace Setup & Collaboration
  // -------------------------------------------------------------
  async enterWorkspace() {
    this.switchView("workspaceView");

    // Update Topbar UI
    document.getElementById("topbarProjectName").textContent = this.session?.workspace_name || "Workspace";
    const roleBadge = document.getElementById("topbarRoleBadge");
    roleBadge.textContent = this.role === "host" ? "Host" : "Peer";
    roleBadge.className = `badge-role ${this.role === "host" ? "host" : "peer"}`;

    document.getElementById("topbarSessionCode").textContent = this.session?.session_code || "FRI-....";
    document.getElementById("topbarAddress").textContent = this._getInviteUrl();

    document.getElementById("statusRoleLabel").textContent = this.role === "host" ? "Host (Workspace Owner)" : "Participant (Guest)";
    document.getElementById("leaveText").textContent = this.role === "host" ? "End Session" : "Leave";

    // Connect Signaling WebSocket
    this._connectSignaling();

    // Load workspace files
    await this.loadFiles();

    // Start network health ping
    this._startPingMonitor();

    // Open README.md or first available file by default
    setTimeout(() => {
      this._openDefaultFile();
    }, 200);

    showToast(`Entered FriKode workspace as ${this.user.name}!`, "success");
  }

  _openDefaultFile() {
    // Look for README.md or main.py
    const findFile = (items) => {
      for (const item of items) {
        if (!item.is_dir) {
          if (item.name.toLowerCase() === "readme.md" || item.name.toLowerCase() === "main.py") {
            return item.path;
          }
        }
        if (item.children) {
          const found = findFile(item.children);
          if (found) return found;
        }
      }
      return null;
    };

    let targetPath = findFile(this.treeData);
    if (!targetPath && this.treeData.length > 0) {
      // Pick first non-directory
      const pickFirst = (items) => {
        for (const item of items) {
          if (!item.is_dir) return item.path;
          if (item.children) {
            const p = pickFirst(item.children);
            if (p) return p;
          }
        }
        return null;
      };
      targetPath = pickFirst(this.treeData);
    }

    if (targetPath) {
      this.editorManager.openFile(targetPath);
    }
  }

  async loadFiles() {
    try {
      const res = await api.getFiles();
      this.treeData = res.tree || [];
      this._renderFileTree();
    } catch (err) {
      console.error("Failed to load file tree:", err);
      showToast("Failed to refresh file tree", "error");
    }
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
            this.editorManager.openFile(node.path);
            this._renderFileTree();
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
        <div style="padding: 16px; color: var(--text-muted); font-size: 12px; text-align: center;">
          No files in workspace.<br>
          Click + above to create one.
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

    const baseHost = api.baseUrl ? new URL(api.baseUrl).host : window.location.host;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
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
        this._renderPeers();
        this._renderFileTree();
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
      // Avatar pill in topbar
      const initial = (peer.name || "P")[0].toUpperCase();
      const avatar = document.createElement("div");
      avatar.className = "collaborator-avatar";
      avatar.style.backgroundColor = peer.color || "#22d3ee";
      avatar.textContent = initial;
      avatar.title = `${peer.name} (${peer.role})${peer.active_file ? " • " + peer.active_file : ""}`;
      stack.appendChild(avatar);

      // List item in activity drawer
      const listItem = document.createElement("div");
      listItem.className = "peer-list-item";
      listItem.innerHTML = `
        <span class="peer-color-dot" style="background-color: ${peer.color};"></span>
        <div class="peer-info">
          <span class="peer-name">${peer.name} ${peer.id === this.user.id ? "(You)" : ""}</span>
          <span class="peer-file">${peer.active_file || "Browsing files"}</span>
        </div>
      `;
      list.appendChild(listItem);
    });
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

    try {
      await api.createFile(name, this.pendingCreateType === "folder");
      this.closeModal("createEntryModal");
      await this.loadFiles();
      if (this.pendingCreateType === "file") {
        this.editorManager.openFile(name);
      }
      showToast(`Created ${name}`, "success");
    } catch (err) {
      showToast(err.message || "Failed to create item", "error");
    }
  }

  openDeleteModal(path) {
    this.pendingDeletePath = path;
    document.getElementById("deleteConfirmText").textContent = `Are you sure you want to delete "${path}"?`;
    this.openModal("deleteConfirmModal");
  }

  async confirmDeleteEntry() {
    if (!this.pendingDeletePath) return;

    try {
      await api.deleteFile(this.pendingDeletePath);
      this.editorManager.closeTab(this.pendingDeletePath);
      this.closeModal("deleteConfirmModal");
      await this.loadFiles();
      showToast(`Deleted ${this.pendingDeletePath}`, "success");
    } catch (err) {
      showToast(err.message || "Failed to delete item", "error");
    }
  }

  // -------------------------------------------------------------
  // Session Exit
  // -------------------------------------------------------------
  async leaveSession() {
    if (this.role === "host") {
      if (confirm("End this FriKode session for all participants?")) {
        try {
          await api.endSession();
        } catch (_) {}
        if (this.signalingWs) this.signalingWs.close();
        this.switchView("homeView");
      }
    } else {
      if (confirm("Leave this collaborative session?")) {
        if (this.signalingWs) this.signalingWs.close();
        this.switchView("homeView");
      }
    }
  }

  // -------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------
  _updateNetworkUI() {
    if (!this.session) return;
    const ip = this.session.primary_ip || "127.0.0.1";
    const port = this.session.port || 4000;
    const fullUrl = `http://${ip}:${port}`;

    document.getElementById("homeLocalIpBadge").textContent = `Wi-Fi Address: ${fullUrl}`;
    document.getElementById("modalHostWifiAddress").textContent = fullUrl;
    document.getElementById("modalHostSessionCode").textContent = this.session.session_code || "FRI-....";
  }

  _getInviteUrl() {
    if (!this.session) return window.location.origin;
    const ip = this.session.primary_ip || window.location.hostname;
    const port = this.session.port || window.location.port || 4000;
    return `http://${ip}:${port}`;
  }

  _normalizeAddress(raw) {
    let cleaned = raw.trim();
    if (!cleaned.startsWith("http://") && !cleaned.startsWith("https://")) {
      if (cleaned.includes(":")) {
        cleaned = `http://${cleaned}`;
      } else {
        cleaned = `http://${cleaned}:4000`;
      }
    }
    return cleaned.replace(/\/$/, "");
  }

  _startPingMonitor() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(async () => {
      try {
        const ping = await api.ping();
        document.getElementById("statusPingText").textContent = `Local Wi-Fi • Ping: ${ping.rtt}ms`;
      } catch (_) {
        document.getElementById("statusPingText").textContent = `Local Wi-Fi • Disconnected`;
      }
    }, 10000);
  }
}

// Instantiate on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  window.frikodeApp = new FriKodeApp();
});

