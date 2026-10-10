/**
 * FriKode Application Controller
 * Handles view switching, session management, file tree, signaling, and presence.
 */

import { api } from "./api.js";
import { EditorManager } from "./editor.js";
import { Icons, getFileIcon } from "./icons.js";
import { ACCENT_COLORS, getRandomColor, copyToClipboard, showToast, formatTime, safeGetStorage, safeSetStorage } from "./utils.js";

class FriKodeApp {
  constructor() {
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

    // Check URL parameters for 1-click invite (?join=1 or ?code=FRI-XXXX)
    const urlParams = new URLSearchParams(window.location.search);
    const codeParam = urlParams.get("code") || urlParams.get("session");
    const joinParam = urlParams.get("join");
    if (codeParam || joinParam) {
      setTimeout(() => {
        this.openJoinModal();
      }, 300);
    }
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
        if (dot) dot.className = `sync-dot ${state}`;
        if (text) {
          if (state === "synced") text.textContent = "Synced";
          else if (state === "saving") text.textContent = "Saving...";
          else if (state === "unsaved") text.textContent = "Unsaved";
          else if (state === "error") text.textContent = "Save Error";
        }
      },
      onTabChange: (tabInfo) => {
        const langEl = document.getElementById("statusLanguage");
        if (langEl) {
          if (tabInfo) {
            langEl.textContent = tabInfo.mode.toUpperCase();
            this._notifyFileFocus(tabInfo.path);
          } else {
            langEl.textContent = "Plain Text";
            this._notifyFileFocus(null);
          }
        }
      }
    });

    this.editorManager.setUser(this.user.name, this.user.color);
  }

  _bindEvents() {
    const bindClick = (id, handler) => {
      const el = document.getElementById(id);
      if (el) el.onclick = handler;
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
    const nameInput = document.getElementById("hostNameInput");
    if (nameInput) {
      nameInput.value = safeGetStorage("frikode_name", this.user.name || "Developer");
    }
    this._initColorSwatches("hostColorSwatches");
    try {
      this.session = await api.getSession();
      this._updateNetworkUI();
    } catch (err) {
      console.warn("Could not refresh session info:", err);
    }
    this.openModal("hostModal");
  }

  async confirmHost() {
    const btn = document.getElementById("btnConfirmHost");
    const origHtml = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span>Starting...</span>`;
    }

    try {
      const workspaceInput = document.getElementById("hostWorkspaceInput")?.value?.trim() || "sample_project";
      const hostName = document.getElementById("hostNameInput")?.value?.trim() || safeGetStorage("frikode_name", "Developer");
      this.user.name = hostName;
      safeSetStorage("frikode_name", hostName);

      try {
        const res = await api.createSession(workspaceInput, false);
        if (!this.session) this.session = {};
        this.session.session_code = res.session_code;
        this.session.workspace_name = res.workspace_name;
      } catch (err) {
        console.error("Failed to reinitialize workspace:", err);
      }

      this.role = "host";
      this.editorManager?.setUser(this.user.name, this.user.color);

      this.closeModal("hostModal");
      await this.enterWorkspace();
    } catch (err) {
      console.error("Error starting host session:", err);
      showToast("Error starting session: " + (err.message || err), "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    }
  }

  // -------------------------------------------------------------
  // Joining Flow
  // -------------------------------------------------------------
  openJoinModal() {
    const nameInput = document.getElementById("joinNameInput");
    if (nameInput) {
      nameInput.value = safeGetStorage("frikode_name", "");
    }
    document.getElementById("joinFeedbackBox").style.display = "none";

    const isRemote = window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";
    const helper = document.getElementById("joinRemoteHelper");
    const label = document.getElementById("joinRemoteHostLabel");
    const hostInput = document.getElementById("joinHostInput");

    // Pre-fill active session code or remote link
    if (this.session?.session_code) {
      hostInput.value = this.session.session_code;
      if (helper && label) {
        helper.style.display = "block";
        const code = this.session.session_code;
        const wsName = this.session.workspace_name || "Workspace";
        label.textContent = `${code} (${wsName})`;
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

    const isCode = !rawInput || (/^(FRI-)?[A-Za-z0-9]{4,8}$/i.test(rawInput) && !rawInput.includes(".") && !rawInput.includes(":") && !rawInput.includes("/"));
    let targetUrl;

    if (isCode) {
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

      const isCode = !rawInput || (/^(FRI-)?[A-Za-z0-9]{4,8}$/i.test(rawInput) && !rawInput.includes(".") && !rawInput.includes(":") && !rawInput.includes("/"));
      let targetUrl;

      if (isCode) {
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
      } catch (err) {
        showToast(`Cannot connect to host: ${err.message || targetUrl}`, "error");
        return;
      }

      this.editorManager?.setUser(this.user.name, this.user.color);
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

    // Connect Signaling WebSocket safely
    try {
      this._connectSignaling();
    } catch (wsErr) {
      console.warn("Signaling initialization warning:", wsErr);
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
    const fullWifiUrl = `http://${ip}:${port}`;
    const isRemote = window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";
    const publicUrl = this.session.public_url || (isRemote ? window.location.origin : null);

    if (publicUrl) {
      document.getElementById("homeLocalIpBadge").textContent = `Remote Link: ${publicUrl}`;
      const publicRow = document.getElementById("modalHostPublicRow");
      if (publicRow) {
        publicRow.style.display = "flex";
        document.getElementById("modalHostPublicAddress").textContent = publicUrl;
      }
    } else {
      document.getElementById("homeLocalIpBadge").textContent = `Wi-Fi Address: ${fullWifiUrl}`;
    }

    // If viewing via remote link or hosted domain, make Join the primary action
    if (isRemote) {
      const btnJoin = document.getElementById("btnOpenJoinModal");
      if (btnJoin) {
        const code = this.session?.session_code ? ` (${this.session.session_code})` : "";
        btnJoin.innerHTML = `<span>Join Active Session${code}</span>`;
        btnJoin.className = "mbot-btn mbot-btn-lime";
      }
      const btnHost = document.getElementById("btnOpenHostModal");
      if (btnHost) {
        btnHost.className = "mbot-btn mbot-btn-tan";
      }
      const btnNavJoin = document.getElementById("btnNavJoin");
      if (btnNavJoin) {
        btnNavJoin.className = "mbot-btn mbot-btn-lime";
      }
      const btnNavHost = document.getElementById("btnNavHost");
      if (btnNavHost) {
        btnNavHost.className = "mbot-btn mbot-btn-tan";
      }
    }

    document.getElementById("modalHostWifiAddress").textContent = fullWifiUrl;
    document.getElementById("modalHostSessionCode").textContent = this.session.session_code || "FRI-....";
  }

  _getInviteUrl() {
    if (!this.session) return window.location.origin;
    if (this.session.public_url) return this.session.public_url;
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

