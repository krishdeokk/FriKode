/**
 * FriKode API Client
 * Wraps REST calls to FriKode local backend.
 */

export class FriKodeApi {
  constructor(baseUrl = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  setBaseUrl(url) {
    this.baseUrl = url.replace(/\/$/, "");
  }

  async _fetch(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    try {
      const res = await fetch(url, {
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        },
        ...options
      });

      if (!res.ok) {
        let errMessage = `HTTP error ${res.status}`;
        try {
          const errData = await res.json();
          if (errData && errData.error) {
            errMessage = errData.error;
          }
        } catch (_) {}
        throw new Error(errMessage);
      }

      return await res.json();
    } catch (err) {
      console.error(`[FriKode API] Error on ${endpoint}:`, err);
      throw err;
    }
  }

  async getSession() {
    return this._fetch("/api/session");
  }

  async createSession(workspacePath, initSample = false) {
    return this._fetch("/api/session/create", {
      method: "POST",
      body: JSON.stringify({
        workspace_path: workspacePath,
        init_sample: initSample
      })
    });
  }

  async endSession() {
    return this._fetch("/api/session/end", {
      method: "POST"
    });
  }

  async getFiles() {
    return this._fetch("/api/files");
  }

  async getFile(path) {
    const encPath = encodeURIComponent(path);
    return this._fetch(`/api/file?path=${encPath}`);
  }

  async saveFile(path, content = null, savedBy = "Peer") {
    return this._fetch("/api/file/save", {
      method: "POST",
      body: JSON.stringify({
        path,
        content,
        saved_by: savedBy
      })
    });
  }

  async createFile(path, isDir = false, content = "") {
    return this._fetch("/api/file/create", {
      method: "POST",
      body: JSON.stringify({
        path,
        is_dir: isDir,
        content
      })
    });
  }

  async renameFile(oldPath, newPath) {
    return this._fetch("/api/file/rename", {
      method: "POST",
      body: JSON.stringify({
        old_path: oldPath,
        new_path: newPath
      })
    });
  }

  async deleteFile(path) {
    return this._fetch("/api/file/delete", {
      method: "POST",
      body: JSON.stringify({
        path
      })
    });
  }

  async ping(targetUrl = null) {
    const start = performance.now();
    const endpoint = targetUrl ? `${targetUrl.replace(/\/$/, "")}/api/ping` : `${this.baseUrl}/api/ping`;
    const res = await fetch(endpoint, { cache: "no-store" });
    if (!res.ok) throw new Error("Ping failed");
    const data = await res.json();
    const rtt = Math.round(performance.now() - start);
    return { ...data, rtt };
  }

  async getTunnel() {
    return this._fetch("/api/tunnel");
  }

  async startTunnel(provider = "auto") {
    return this._fetch("/api/tunnel", {
      method: "POST",
      body: JSON.stringify({
        action: "start",
        provider
      })
    });
  }

  async stopTunnel() {
    return this._fetch("/api/tunnel", {
      method: "POST",
      body: JSON.stringify({
        action: "stop"
      })
    });
  }

  async setCustomTunnelUrl(url) {
    return this._fetch("/api/tunnel", {
      method: "POST",
      body: JSON.stringify({
        action: "set_url",
        url
      })
    });
  }
}

export const api = new FriKodeApi();

