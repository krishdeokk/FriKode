/**
 * FriKode Code Editor & Real-Time CRDT Collaboration Engine
 * Integrates CodeMirror with Yjs CRDT and WebsocketProvider.
 */

import * as Y from "../vendor/yjs.bundle.mjs";
import { WebsocketProvider } from "../vendor/y-websocket.bundle.mjs";
import { CodeMirrorBinding } from "../vendor/y-codemirror.bundle.mjs";
import { api } from "./api.js";
import { Icons, getFileIcon } from "./icons.js";

export class EditorManager {
  constructor({ onCursorChange, onSaveStateChange, onTabChange, onAwarenessChange, onFileSave } = {}) {
    this.container = document.getElementById("editorContainer");
    this.tabsBar = document.getElementById("tabsBar");
    this.breadcrumb = document.getElementById("breadcrumbPath");
    this.emptyState = document.getElementById("editorEmptyState");
    
    this.onCursorChange = onCursorChange || (() => {});
    this.onSaveStateChange = onSaveStateChange || (() => {});
    this.onTabChange = onTabChange || (() => {});
    this.onAwarenessChange = onAwarenessChange || (() => {});
    this.onFileSave = onFileSave || (() => {});

    this.sessionCode = null;
    this.role = "host";

    this.user = {
      name: "Anonymous",
      color: "#22d3ee"
    };

    this.cm = null;
    this.openTabs = new Map(); // path -> { path, name, ydoc, ytext, ymeta, provider, binding, dirty, lang }
    this.activePath = null;
    this.autoSaveTimer = null;

    this._initCodeMirror();
  }

  setRole(role) {
    this.role = role || "host";
  }

  setSessionCode(code) {
    this.sessionCode = code;
  }

  getActiveFile() {
    return this.activePath || "";
  }

  getValue() {
    if (this.cm) return this.cm.getValue();
    if (this.activePath && this.openTabs.has(this.activePath)) {
      return this.openTabs.get(this.activePath).ytext.toString();
    }
    return "";
  }

  _isStaticMode() {
    return (window.location.hostname.endsWith("github.io") || window.location.protocol === "file:") && !api.baseUrl;
  }

  setUser(name, color) {
    this.user.name = name;
    this.user.color = color;
    // Update awareness on all active providers
    for (const tab of this.openTabs.values()) {
      if (tab.provider && tab.provider.awareness) {
        tab.provider.awareness.setLocalStateField("user", {
          name: this.user.name,
          color: this.user.color
        });
      }
    }
  }

  _initCodeMirror() {
    if (this.cm) return true;
    if (typeof window.CodeMirror !== "function") {
      console.warn("[FriKode] CodeMirror not ready on window yet; waiting...");
      if (!this._cmPoll) {
        let attempts = 0;
        this._cmPoll = setInterval(() => {
          attempts++;
          if (typeof window.CodeMirror === "function") {
            clearInterval(this._cmPoll);
            this._cmPoll = null;
            this._initCodeMirror();
            if (this.activePath) {
              const p = this.activePath;
              this.activePath = null;
              this.switchTab(p);
            }
          } else if (attempts > 60) {
            clearInterval(this._cmPoll);
            this._cmPoll = null;
          }
        }, 100);
      }
      return false;
    }

    this.cm = window.CodeMirror(this.container, {
      lineNumbers: true,
      theme: "frikode",
      mode: "python",
      tabSize: 4,
      indentUnit: 4,
      indentWithTabs: false,
      lineWrapping: false,
      matchBrackets: true,
      autoCloseBrackets: true,
      styleActiveLine: true,
      viewportMargin: 50,
      readOnly: false
    });

    // Hide editor until a file is opened
    this.cm.getWrapperElement().style.display = "none";

    // Track cursor activity for status bar
    this.cm.on("cursorActivity", () => {
      if (!this.activePath) return;
      const cursor = this.cm.getCursor();
      this.onCursorChange({ line: cursor.line + 1, col: cursor.ch + 1 });
    });

    // Track edits for dirty state
    this.cm.on("change", (cm, changeObj) => {
      if (!this.activePath) return;
      if (changeObj.origin === "setValue") return;

      const tab = this.openTabs.get(this.activePath);
      if (tab && !tab.dirty) {
        tab.dirty = true;
        this._updateTabUI(this.activePath);
        this.onSaveStateChange("unsaved");
      }

      // Schedule debounced auto-save to host disk
      this._scheduleAutoSave();
    });

    // Keyboard shortcut Cmd-S / Ctrl-S
    this.cm.addKeyMap({
      "Cmd-S": () => this.saveCurrentFile(),
      "Ctrl-S": () => this.saveCurrentFile()
    });
  }

  async openFile(path, initialContent = null, language = null) {
    if (this.activePath === path) return;

    // Check if already open in tabs
    if (this.openTabs.has(path)) {
      this.switchTab(path);
      return;
    }

    const filename = path.split("/").pop();
    const mode = this._getModeForPath(path);

    // If user is a participant joining a session, never use initialContent to overwrite the room
    const isParticipant = this.role === "participant";
    let content = isParticipant ? null : initialContent;

    // If initialContent is not supplied and this is the host on a backend server, fetch from REST API
    if (content === null && !this._isStaticMode() && !isParticipant) {
      try {
        const fileData = await api.getFile(path, this.sessionCode);
        content = fileData.content || "";
      } catch (err) {
        console.error("Failed to fetch file content:", err);
        content = "";
      }
    } else if (content === null && this._isStaticMode() && !isParticipant) {
      try {
        const raw = localStorage.getItem("frikode_workspaces_v1");
        if (raw) {
          const all = JSON.parse(raw);
          const cleanCode = (this.sessionCode || "").toUpperCase().replace(/^FRI-/, "");
          for (const ws of Object.values(all)) {
            if (cleanCode && ws.session_code && ws.session_code.toUpperCase().replace(/^FRI-/, "") === cleanCode) {
              if (ws.files && ws.files[cleanPath] && ws.files[cleanPath].content !== undefined) {
                content = ws.files[cleanPath].content;
                break;
              }
            }
          }
        }
      } catch (_) {}
    }

    // Initialize Yjs CRDT room for this file
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    const ymeta = ydoc.getMap("meta");

    // Establish WebSocket provider to server room
    let host = window.location.host;
    let protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (api.baseUrl) {
      try {
        const parsed = new URL(api.baseUrl);
        host = parsed.host;
        protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      } catch (_) {}
    }

    const isStandaloneStatic = this._isStaticMode();
    let wsUrl, roomName;
    const cleanPath = path.replace(/^\.\//, "").trim();
    if (isStandaloneStatic) {
      // Connect to public demo relay for peer-to-peer real-time sync with teammates
      wsUrl = "wss://demos.yjs.dev/ws";
      const cleanCode = (this.sessionCode || "public-room").toUpperCase().trim().replace(/^FRI-/, "FRI-");
      roomName = `frikode-${cleanCode}-${cleanPath}`;
    } else {
      wsUrl = `${protocol}//${host}/ws/yjs`;
      const cleanCode = (this.sessionCode || "default").toUpperCase().trim();
      roomName = `${cleanCode}/${cleanPath}`;
    }

    const provider = new WebsocketProvider(wsUrl, roomName, ydoc, { connect: true });

    // Populate initial content safely:
    // 1. Participants NEVER insert initial content (they strictly receive what is already in the room).
    // 2. Once a document is marked initialized in the CRDT (ymeta.get("initialized") === true), it is never overwritten.
    // 3. If ytext already has any text from peers upon sync, preserve peers' text.
    // 4. Erasing code or clearing a file (ytext.toString() === "") is a deliberate user edit, NEVER a reason to reset.
    let initialApplied = false;
    const applyInitial = () => {
      if (initialApplied) return;
      if (this.role === "participant") {
        initialApplied = true;
        return;
      }
      if (ymeta.get("initialized")) {
        initialApplied = true;
        return;
      }
      if (ytext.toString().length > 0) {
        initialApplied = true;
        ymeta.set("initialized", true);
        return;
      }
      // If the document has any recorded client transactions, it has already been edited
      if (ydoc.store.clients.size > 0 && ymeta.get("initialized")) {
        initialApplied = true;
        return;
      }

      initialApplied = true;
      ymeta.set("initialized", true);
      if (content) {
        ytext.insert(0, content);
      }
    };

    provider.on("sync", (isSynced) => {
      if (isSynced) {
        applyInitial();
      }
    });

    // Fallback if offline or standalone room doesn't emit sync within 3.5s (ONLY for host, NEVER for participant)
    setTimeout(() => {
      if (!provider.synced && this.role !== "participant" && !ymeta.get("initialized")) {
        applyInitial();
      }
    }, 3500);

    // Set user awareness (presence name, cursor color, and active file)
    provider.awareness.setLocalStateField("user", {
      name: this.user.name,
      color: this.user.color,
      file: cleanPath
    });

    provider.awareness.on("change", () => {
      if (this.onAwarenessChange) {
        const states = [];
        provider.awareness.getStates().forEach((state, clientId) => {
          states.push({
            clientId,
            isLocal: clientId === provider.awareness.clientID,
            ...state
          });
        });
        this.onAwarenessChange(states, provider.awareness);
      }
    });

    const tabData = {
      path,
      name: filename,
      ydoc,
      ytext,
      ymeta,
      provider,
      binding: null,
      dirty: false,
      mode
    };

    this.openTabs.set(path, tabData);
    this._renderTabs();
    this.switchTab(path);
  }

  switchTab(path) {
    const tab = this.openTabs.get(path);
    if (!tab) return;

    // Clean up previous binding
    if (this.activePath && this.openTabs.has(this.activePath)) {
      const prevTab = this.openTabs.get(this.activePath);
      if (prevTab.binding) {
        prevTab.binding.destroy();
        prevTab.binding = null;
      }
    }

    this.activePath = path;

    if (!this.cm) {
      this._initCodeMirror();
      if (!this.cm) return;
    }

    // Show CodeMirror, hide empty state
    this.emptyState.style.display = "none";
    this.cm.getWrapperElement().style.display = "block";

    // Update editor mode
    this.cm.setOption("mode", tab.mode);

    // Bind Y.Text to CodeMirror
    tab.binding = new CodeMirrorBinding(tab.ytext, this.cm, tab.provider.awareness);

    // Update UI elements
    this._updateActiveTabUI();
    this.breadcrumb.textContent = path;
    this.cm.refresh();

    // Notify listeners
    this.onTabChange({ path, mode: tab.mode, dirty: tab.dirty });
    this.onSaveStateChange(tab.dirty ? "unsaved" : "synced");

    const cursor = this.cm.getCursor();
    this.onCursorChange({ line: cursor.line + 1, col: cursor.ch + 1 });

    // Focus editor and emit initial cursor coordinates to peers
    setTimeout(() => {
      if (this.cm && tab.binding) {
        this.cm.focus();
        try {
          tab.binding.emit("cursorActivity", [this.cm]);
        } catch (_) {}
      }
    }, 60);
  }

  closeTab(path, event = null) {
    if (event) event.stopPropagation();

    const tab = this.openTabs.get(path);
    if (!tab) return;

    // Destroy Yjs binding and provider
    if (tab.binding) {
      tab.binding.destroy();
    }
    if (tab.provider) {
      tab.provider.destroy();
    }
    if (tab.ydoc) {
      tab.ydoc.destroy();
    }

    this.openTabs.delete(path);

    // If closed tab was active, switch to next available tab or show empty state
    if (this.activePath === path) {
      const remainingPaths = Array.from(this.openTabs.keys());
      if (remainingPaths.length > 0) {
        this.switchTab(remainingPaths[remainingPaths.length - 1]);
      } else {
        this.activePath = null;
        this.cm.getWrapperElement().style.display = "none";
        this.emptyState.style.display = "flex";
        this.breadcrumb.textContent = "No file opened";
        this.onTabChange(null);
        this.onSaveStateChange("synced");
      }
    }

    this._renderTabs();
  }

  closeAllTabs() {
    const paths = Array.from(this.openTabs.keys());
    for (const p of paths) {
      this.closeTab(p);
    }
  }

  async saveCurrentFile() {
    if (!this.activePath) return;

    const tab = this.openTabs.get(this.activePath);
    if (!tab) return;

    this.onSaveStateChange("saving");

    try {
      const text = this.cm.getValue();
      const isStandaloneStatic = this._isStaticMode();
      if (!isStandaloneStatic) {
        await api.saveFile(this.activePath, text, this.user.name);
      }
      tab.dirty = false;
      this._updateTabUI(this.activePath);
      this.onSaveStateChange("synced");
      if (this.onFileSave) {
        this.onFileSave(this.activePath, text);
      }
    } catch (err) {
      const isStandaloneStatic = this._isStaticMode();
      if (isStandaloneStatic) {
        tab.dirty = false;
        this._updateTabUI(this.activePath);
        this.onSaveStateChange("synced");
        if (this.onFileSave) {
          this.onFileSave(this.activePath, this.cm.getValue());
        }
      } else {
        console.error("Failed to save file:", err);
        this.onSaveStateChange("error");
      }
    }
  }

  _scheduleAutoSave() {
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => {
      if (this.activePath && this.openTabs.get(this.activePath)?.dirty) {
        this.saveCurrentFile();
      }
    }, 2500);
  }

  _getModeForPath(path) {
    const ext = path.split(".").pop().toLowerCase();
    switch (ext) {
      case "py": return "python";
      case "js":
      case "mjs":
      case "cjs":
      case "json": return "javascript";
      case "html":
      case "htm": return "htmlmixed";
      case "css": return "css";
      case "xml":
      case "svg": return "xml";
      case "md": return "markdown";
      case "rs": return "rust";
      case "c":
      case "cpp":
      case "h":
      case "hpp":
      case "java":
      case "cs": return "clike";
      default: return "null";
    }
  }

  _renderTabs() {
    this.tabsBar.innerHTML = "";
    for (const [path, tab] of this.openTabs.entries()) {
      const tabEl = document.createElement("div");
      tabEl.className = `tab-item ${path === this.activePath ? "active" : ""}`;
      tabEl.onclick = () => this.switchTab(path);

      const fileInfo = getFileIcon(tab.name);
      
      tabEl.innerHTML = `
        <span style="color: ${fileInfo.color}">${fileInfo.icon}</span>
        <span class="tab-name">${tab.name}</span>
        ${tab.dirty ? `<span class="tab-dirty-indicator"></span>` : ""}
        <button class="tab-close-btn" title="Close">${Icons.close}</button>
      `;

      const closeBtn = tabEl.querySelector(".tab-close-btn");
      closeBtn.onclick = (e) => this.closeTab(path, e);

      this.tabsBar.appendChild(tabEl);
    }
  }

  _updateActiveTabUI() {
    const tabs = this.tabsBar.querySelectorAll(".tab-item");
    tabs.forEach(t => t.classList.remove("active"));
    for (const [path, tab] of this.openTabs.entries()) {
      if (path === this.activePath) {
        this._renderTabs();
        break;
      }
    }
  }

  _updateTabUI(path) {
    this._renderTabs();
  }
}

