"""
FriKode Multi-Language Code Runner & Compiler
Executes user code securely within the host workspace with timeout, stdin support,
and output capture for Python, C, C++, Bash, and JavaScript.
"""

import logging
import os
import shutil
import subprocess
import tempfile
import time
from typing import Dict, Any, Optional

logger = logging.getLogger("frikode.runner")

MAX_OUTPUT_CHARS = 300_000
DEFAULT_TIMEOUT = 12.0
MAX_TIMEOUT = 30.0

EXT_MAP = {
    ".py": "python",
    ".c": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".sh": "bash",
    ".bash": "bash",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
}


class CodeRunner:
    """
    Executes and compiles source code within the workspace context.
    """

    def __init__(self, workspace_path: str):
        self.workspace_path = os.path.abspath(workspace_path)

    def detect_language(self, path: Optional[str], code: Optional[str] = None) -> str:
        """Determines programming language from filename or code snippet."""
        if path:
            _, ext = os.path.splitext(path.lower())
            if ext in EXT_MAP:
                return EXT_MAP[ext]

        if code:
            code_lower = code.lower().strip()
            if "#include" in code_lower and ("<stdio.h>" in code_lower or "printf" in code_lower):
                return "c"
            if "#include" in code_lower and ("<iostream>" in code_lower or "std::cout" in code_lower):
                return "cpp"
            if "import " in code or "def " in code or "print(" in code:
                return "python"
            if "console.log" in code or "function " in code or "const " in code or "let " in code:
                return "javascript"

        return "python"

    def run(
        self,
        path: Optional[str] = None,
        code: Optional[str] = None,
        language: str = "auto",
        stdin_data: str = "",
        timeout: float = DEFAULT_TIMEOUT
    ) -> Dict[str, Any]:
        """
        Executes code or file and returns structured output.
        """
        timeout = min(max(1.0, float(timeout)), MAX_TIMEOUT)
        lang = self.detect_language(path, code) if language == "auto" else language.lower()

        # Resolve or prepare source file
        temp_file = None
        temp_bin = None
        target_file = None

        try:
            if code is not None and code.strip():
                # Run provided buffer (unsaved changes or untitled code)
                suffix = {
                    "python": ".py",
                    "c": ".c",
                    "cpp": ".cpp",
                    "bash": ".sh",
                    "javascript": ".js"
                }.get(lang, ".txt")
                
                # Write to temp file inside workspace so relative imports/assets work
                tmp_dir = os.path.join(self.workspace_path, ".frikode_tmp")
                os.makedirs(tmp_dir, exist_ok=True)
                fd, temp_file = tempfile.mkstemp(suffix=suffix, dir=tmp_dir)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(code)
                target_file = temp_file
            elif path:
                # Run existing workspace file
                clean_path = path.lstrip("/\\")
                full_path = os.path.abspath(os.path.join(self.workspace_path, clean_path))
                if not full_path.startswith(self.workspace_path) or not os.path.isfile(full_path):
                    return {
                        "status": "error",
                        "language": lang,
                        "stdout": "",
                        "stderr": f"File not found or outside workspace: {path}",
                        "exit_code": 1,
                        "duration_ms": 0,
                        "file": path or "unknown"
                    }
                target_file = full_path
            else:
                return {
                    "status": "error",
                    "language": lang,
                    "stdout": "",
                    "stderr": "No code or file path provided to execute.",
                    "exit_code": 1,
                    "duration_ms": 0,
                    "file": "none"
                }

            # Working directory for execution: parent directory of target file
            work_dir = os.path.dirname(target_file)

            # Route execution by language
            start_time = time.perf_counter()

            if lang == "python":
                res = self._run_python(target_file, work_dir, stdin_data, timeout)
            elif lang == "c":
                res, temp_bin = self._run_c(target_file, work_dir, stdin_data, timeout)
            elif lang == "cpp":
                res, temp_bin = self._run_cpp(target_file, work_dir, stdin_data, timeout)
            elif lang in ("bash", "sh"):
                res = self._run_bash(target_file, work_dir, stdin_data, timeout)
            elif lang == "javascript":
                res = self._run_javascript(target_file, work_dir, stdin_data, timeout)
            else:
                return {
                    "status": "unsupported",
                    "language": lang,
                    "stdout": "",
                    "stderr": f"Execution for language '{lang}' is not supported yet.",
                    "exit_code": 1,
                    "duration_ms": 0,
                    "file": os.path.basename(target_file)
                }

            duration_ms = round((time.perf_counter() - start_time) * 1000, 1)
            res["duration_ms"] = duration_ms
            res["language"] = lang
            res["file"] = os.path.basename(path) if path else os.path.basename(target_file)
            return res

        finally:
            if temp_file and os.path.exists(temp_file):
                try:
                    os.remove(temp_file)
                except Exception:
                    pass
            if temp_bin and os.path.exists(temp_bin):
                try:
                    os.remove(temp_bin)
                except Exception:
                    pass

    def _run_process(self, cmd: list, cwd: str, stdin_data: str, timeout: float) -> Dict[str, Any]:
        """Runs a process with stdin, timeout, and captures output."""
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=cwd,
                stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1
            )

            try:
                stdout, stderr = proc.communicate(input=stdin_data, timeout=timeout)
                returncode = proc.returncode
                status = "success" if returncode == 0 else "error"
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout, stderr = proc.communicate()
                returncode = -1
                status = "timeout"
                stderr = (stderr or "") + f"\n[Execution timed out after {timeout:.1f}s]"

            # Truncate large outputs safely
            if len(stdout) > MAX_OUTPUT_CHARS:
                stdout = stdout[:MAX_OUTPUT_CHARS] + f"\n... [Output truncated at {MAX_OUTPUT_CHARS} chars]"
            if len(stderr) > MAX_OUTPUT_CHARS:
                stderr = stderr[:MAX_OUTPUT_CHARS] + f"\n... [Error output truncated at {MAX_OUTPUT_CHARS} chars]"

            return {
                "status": status,
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": returncode
            }

        except Exception as e:
            return {
                "status": "error",
                "stdout": "",
                "stderr": f"Process execution failed: {str(e)}",
                "exit_code": 1
            }

    def _run_python(self, file_path: str, cwd: str, stdin_data: str, timeout: float) -> Dict[str, Any]:
        python_bin = shutil.which("python3") or shutil.which("python") or "python3"
        cmd = [python_bin, "-u", file_path]
        return self._run_process(cmd, cwd, stdin_data, timeout)

    def _run_c(self, file_path: str, cwd: str, stdin_data: str, timeout: float):
        cc = shutil.which("clang") or shutil.which("gcc")
        if not cc:
            return {
                "status": "error",
                "stdout": "",
                "stderr": "C compiler (clang or gcc) not found on system.",
                "exit_code": 1
            }, None

        bin_path = file_path + ".out"
        compile_cmd = [cc, "-O2", file_path, "-o", bin_path, "-lm"]
        comp_res = self._run_process(compile_cmd, cwd, None, timeout=8.0)
        if comp_res["exit_code"] != 0:
            comp_res["status"] = "compile_error"
            return comp_res, None

        exec_res = self._run_process([bin_path], cwd, stdin_data, timeout)
        return exec_res, bin_path

    def _run_cpp(self, file_path: str, cwd: str, stdin_data: str, timeout: float):
        cxx = shutil.which("clang++") or shutil.which("g++")
        if not cxx:
            return {
                "status": "error",
                "stdout": "",
                "stderr": "C++ compiler (clang++ or g++) not found on system.",
                "exit_code": 1
            }, None

        bin_path = file_path + ".out"
        compile_cmd = [cxx, "-std=c++17", "-O2", file_path, "-o", bin_path, "-lm"]
        comp_res = self._run_process(compile_cmd, cwd, None, timeout=10.0)
        if comp_res["exit_code"] != 0:
            comp_res["status"] = "compile_error"
            return comp_res, None

        exec_res = self._run_process([bin_path], cwd, stdin_data, timeout)
        return exec_res, bin_path

    def _run_bash(self, file_path: str, cwd: str, stdin_data: str, timeout: float) -> Dict[str, Any]:
        bash_bin = shutil.which("bash") or "/bin/bash"
        cmd = [bash_bin, file_path]
        return self._run_process(cmd, cwd, stdin_data, timeout)

    def _run_javascript(self, file_path: str, cwd: str, stdin_data: str, timeout: float) -> Dict[str, Any]:
        node_bin = shutil.which("node")
        if node_bin:
            return self._run_process([node_bin, file_path], cwd, stdin_data, timeout)
        # If Node is not installed on host, inform client to evaluate client-side
        return {
            "status": "client_eval",
            "stdout": "",
            "stderr": "Node.js not installed on host. Running in browser JavaScript sandbox...",
            "exit_code": 0,
            "client_eval": True
        }
