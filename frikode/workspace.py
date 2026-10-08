"""
FriKode Workspace Manager
Handles local file system operations within a designated project folder.
Enforces strict security boundaries to prevent path traversal attacks.
"""

import os
import shutil
import time
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple


# Files/folders to hide from workspace explorer to prevent clutter and security leaks
IGNORED_PATTERNS = {
    ".git", ".venv", "venv", "__pycache__", ".DS_Store", "node_modules",
    ".pytest_cache", ".mypy_cache", ".idea", ".vscode"
}


class WorkspaceSecurityError(Exception):
    """Raised when an operation attempts to escape the workspace boundary."""
    pass


class Workspace:
    def __init__(self, root_path: str):
        self.root_path = os.path.realpath(os.path.abspath(root_path))
        if not os.path.exists(self.root_path):
            os.makedirs(self.root_path, exist_ok=True)

    @property
    def name(self) -> str:
        return os.path.basename(self.root_path) or "Workspace"

    def _resolve_safe_path(self, rel_path: str) -> str:
        """
        Resolves a relative path within the workspace root.
        Strictly ensures that the target cannot escape the root boundary.
        """
        # Normalize slashes and strip leading separators
        clean_rel = rel_path.strip().replace("\\", "/").lstrip("/")
        
        target = os.path.realpath(os.path.join(self.root_path, clean_rel))
        
        # Security assertion: target MUST be inside self.root_path
        try:
            common = os.path.commonpath([self.root_path, target])
        except ValueError:
            # Different drives on Windows
            raise WorkspaceSecurityError(f"Access denied: path outside workspace boundary: {rel_path}")

        if common != self.root_path:
            raise WorkspaceSecurityError(f"Access denied: Path traversal detected: {rel_path}")

        return target

    def get_tree(self) -> List[Dict[str, Any]]:
        """
        Returns a nested tree structure of files and folders in the workspace.
        """
        def _build_tree(dir_path: str) -> List[Dict[str, Any]]:
            entries = []
            try:
                items = sorted(os.listdir(dir_path), key=lambda s: s.lower())
            except (PermissionError, OSError):
                return []

            for item in items:
                if item in IGNORED_PATTERNS or item.startswith("."):
                    continue

                full_path = os.path.join(dir_path, item)
                rel_path = os.path.relpath(full_path, self.root_path).replace("\\", "/")
                is_directory = os.path.isdir(full_path)

                entry: Dict[str, Any] = {
                    "name": item,
                    "path": rel_path,
                    "is_dir": is_directory,
                }

                if is_directory:
                    entry["children"] = _build_tree(full_path)
                else:
                    try:
                        stat = os.stat(full_path)
                        entry["size"] = stat.st_size
                        entry["modified"] = stat.st_mtime
                        entry["extension"] = os.path.splitext(item)[1].lower()
                    except OSError:
                        entry["size"] = 0
                        entry["modified"] = 0
                        entry["extension"] = ""

                entries.append(entry)

            # Sort: folders first, then files alphabetically
            return sorted(entries, key=lambda x: (not x["is_dir"], x["name"].lower()))

        return _build_tree(self.root_path)

    def read_file(self, rel_path: str) -> Tuple[str, str]:
        """
        Reads content of a file within the workspace.
        Returns (content, detected_language/mode).
        """
        safe_path = self._resolve_safe_path(rel_path)
        if not os.path.exists(safe_path):
            raise FileNotFoundError(f"File not found: {rel_path}")
        if os.path.isdir(safe_path):
            raise IsADirectoryError(f"Target is a directory, not a file: {rel_path}")

        try:
            with open(safe_path, "r", encoding="utf-8") as f:
                content = f.read()
        except UnicodeDecodeError:
            # Fallback reading as latin-1 or indicate binary
            with open(safe_path, "r", encoding="latin-1", errors="replace") as f:
                content = f.read()

        lang = self.detect_language(rel_path)
        return content, lang

    def write_file(self, rel_path: str, content: str) -> None:
        """
        Writes content to a file safely. Creates parent directories if needed.
        """
        safe_path = self._resolve_safe_path(rel_path)
        parent_dir = os.path.dirname(safe_path)
        os.makedirs(parent_dir, exist_ok=True)

        # Atomic-like write using temp file
        temp_path = f"{safe_path}.tmp.{int(time.time() * 1000)}"
        with open(temp_path, "w", encoding="utf-8") as f:
            f.write(content)
        
        # Atomic replace
        os.replace(temp_path, safe_path)

    def create_file(self, rel_path: str, initial_content: str = "") -> None:
        """Creates a new empty or initialized file."""
        safe_path = self._resolve_safe_path(rel_path)
        if os.path.exists(safe_path):
            raise FileExistsError(f"File already exists: {rel_path}")
        parent_dir = os.path.dirname(safe_path)
        os.makedirs(parent_dir, exist_ok=True)
        with open(safe_path, "w", encoding="utf-8") as f:
            f.write(initial_content)

    def create_folder(self, rel_path: str) -> None:
        """Creates a new directory within the workspace."""
        safe_path = self._resolve_safe_path(rel_path)
        os.makedirs(safe_path, exist_ok=True)

    def delete_item(self, rel_path: str) -> None:
        """Deletes a file or directory safely."""
        safe_path = self._resolve_safe_path(rel_path)
        if safe_path == self.root_path:
            raise WorkspaceSecurityError("Cannot delete the workspace root.")
        if not os.path.exists(safe_path):
            raise FileNotFoundError(f"Item not found: {rel_path}")

        if os.path.isdir(safe_path):
            shutil.rmtree(safe_path)
        else:
            os.remove(safe_path)

    def rename_item(self, old_rel_path: str, new_rel_path: str) -> None:
        """Renames or moves a file/folder within the workspace."""
        safe_old = self._resolve_safe_path(old_rel_path)
        safe_new = self._resolve_safe_path(new_rel_path)

        if not os.path.exists(safe_old):
            raise FileNotFoundError(f"Source item not found: {old_rel_path}")
        if os.path.exists(safe_new):
            raise FileExistsError(f"Target item already exists: {new_rel_path}")

        os.makedirs(os.path.dirname(safe_new), exist_ok=True)
        os.rename(safe_old, safe_new)

    def is_empty(self) -> bool:
        """Checks if the workspace contains any non-ignored items."""
        return len(self.get_tree()) == 0

    def init_sample_project(self) -> None:
        """Populates the workspace with a polished starter multi-file project."""
        files = {
            "README.md": (
                "# Welcome to FriKode\n\n"
                "FriKode is a local-network collaborative code editor for developers on the same Wi-Fi.\n\n"
                "## Key Features\n"
                "- **Zero Cloud**: Runs 100% locally on your machine.\n"
                "- **Real-time CRDT Sync**: Edit files simultaneously with teammates without collisions.\n"
                "- **Collaborator Presence**: See peer cursors, selections, and active files in real time.\n"
                "- **Local Network Sharing**: Connect instantly using your Wi-Fi address or session code.\n\n"
                "## Quick Start\n"
                "1. Invite teammates using the Wi-Fi link in the top bar.\n"
                "2. Click any file in the explorer to start collaborating live!\n"
            ),
            "main.py": (
                "\"\"\"\n"
                "FriKode Starter Demo\n"
                "Try editing this function with your peers simultaneously!\n"
                "\"\"\"\n\n"
                "def calculate_mesh_latency(peer_count: int, ping_ms: float) -> dict:\n"
                "    \"\"\"Simulates network stats for local Wi-Fi peer mesh.\"\"\"\n"
                "    avg_rtt = ping_ms * 1.15\n"
                "    status = \"Optimal\" if avg_rtt < 20 else \"Nominal\"\n"
                "    return {\n"
                "        \"peers\": peer_count,\n"
                "        \"rtt_ms\": round(avg_rtt, 2),\n"
                "        \"status\": status,\n"
                "    }\n\n\n"
                "if __name__ == \"__main__\":\n"
                "    stats = calculate_mesh_latency(peer_count=4, ping_ms=3.5)\n"
                "    print(f\"[FriKode] Local Session Active: {stats}\")\n"
            ),
            "app.js": (
                "/**\n"
                " * FriKode Peer Collaboration Client Logic\n"
                " * Real-time event handler demo.\n"
                " */\n\n"
                "class PeerSession {\n"
                "  constructor(sessionId, hostIp) {\n"
                "    this.sessionId = sessionId;\n"
                "    this.hostIp = hostIp;\n"
                "    this.collaborators = new Set();\n"
                "  }\n\n"
                "  registerCollaborator(name, color) {\n"
                "    this.collaborators.add({ name, color, joinedAt: Date.now() });\n"
                "    console.log(`[FriKode] Collaborator ${name} joined the room!`);\n"
                "  }\n\n"
                "  getActiveCount() {\n"
                "    return this.collaborators.size;\n"
                "  }\n"
                "}\n\n"
                "// Export for usage\n"
                "export default PeerSession;\n"
            ),
            "index.html": (
                "<!DOCTYPE html>\n"
                "<html lang=\"en\">\n"
                "<head>\n"
                "  <meta charset=\"UTF-8\">\n"
                "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n"
                "  <title>FriKode Project</title>\n"
                "  <link rel=\"stylesheet\" href=\"style.css\">\n"
                "</head>\n"
                "<body>\n"
                "  <main class=\"container\">\n"
                "    <h1>Welcome to FriKode Live Session</h1>\n"
                "    <p>Multiple developers editing this HTML in real-time over local Wi-Fi.</p>\n"
                "  </main>\n"
                "</body>\n"
                "</html>\n"
            ),
            "style.css": (
                "/* FriKode Sample Stylesheet */\n"
                ":root {\n"
                "  --bg-primary: #0b0f17;\n"
                "  --accent-cyan: #38bdf8;\n"
                "  --accent-violet: #a855f7;\n"
                "  --text-main: #f1f5f9;\n"
                "}\n\n"
                "body {\n"
                "  background-color: var(--bg-primary);\n"
                "  color: var(--text-main);\n"
                "  font-family: system-ui, -apple-system, sans-serif;\n"
                "  margin: 0;\n"
                "  padding: 2rem;\n"
                "}\n\n"
                ".container {\n"
                "  max-width: 800px;\n"
                "  margin: 0 auto;\n"
                "  border: 1px solid rgba(255, 255, 255, 0.1);\n"
                "  border-radius: 8px;\n"
                "  padding: 1.5rem;\n"
                "}\n"
            ),
            "config.json": (
                "{\n"
                "  \"project\": \"FriKode Local Demo\",\n"
                "  \"version\": \"1.0.0\",\n"
                "  \"network\": {\n"
                "    \"mode\": \"peer-mesh\",\n"
                "    \"port\": 4000,\n"
                "    \"protocol\": \"ws\"\n"
                "  },\n"
                "  \"features\": [\n"
                "    \"real-time crdt\",\n"
                "    \"presence cursors\",\n"
                "    \"zero cloud dependency\"\n"
                "  ]\n"
                "}\n"
            )
        }

        for rel_path, content in files.items():
            self.create_file(rel_path, content)

    @staticmethod
    def detect_language(file_path: str) -> str:
        """Maps file extensions to CodeMirror modes."""
        ext = os.path.splitext(file_path)[1].lower()
        mapping = {
            ".py": "python",
            ".js": "javascript",
            ".mjs": "javascript",
            ".cjs": "javascript",
            ".ts": "javascript",
            ".jsx": "javascript",
            ".tsx": "javascript",
            ".json": "javascript",
            ".html": "htmlmixed",
            ".htm": "htmlmixed",
            ".xml": "xml",
            ".svg": "xml",
            ".css": "css",
            ".scss": "css",
            ".md": "markdown",
            ".markdown": "markdown",
            ".c": "clike",
            ".cpp": "clike",
            ".h": "clike",
            ".hpp": "clike",
            ".java": "clike",
            ".rs": "rust",
            ".go": "clike",
            ".sh": "shell",
            ".bash": "shell",
            ".zsh": "shell",
            ".yaml": "yaml",
            ".yml": "yaml",
            ".sql": "sql",
        }
        return mapping.get(ext, "null")

