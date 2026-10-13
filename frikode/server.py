"""
FriKode Real-Time Collaboration Server
Handles HTTP REST API, WebSockets signaling, and Yjs CRDT synchronization.
"""

import asyncio
import json
import logging
import os
import sys
import time
import tempfile
from typing import Dict, Set, Optional, Any, Tuple
from pathlib import Path

from aiohttp import web, WSMsgType
import anyio
from ypy_websocket import WebsocketServer
import y_py as Y

from .network import get_local_ip_addresses, get_primary_ip, generate_session_code
from .runner import CodeRunner
from .tunnel import get_tunnel_manager
from .workspace import Workspace, WorkspaceSecurityError

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("frikode")


class AiohttpWebsocketAdapter:
    """Adapts an aiohttp WebSocket to the ypy_websocket.Websocket protocol."""
    def __init__(self, ws: web.WebSocketResponse, path: str):
        self._ws = ws
        self._path = path

    @property
    def path(self) -> str:
        return self._path

    def __aiter__(self):
        return self

    async def __anext__(self) -> bytes:
        try:
            return await self.recv()
        except Exception:
            raise StopAsyncIteration

    async def send(self, message: bytes) -> None:
        if not self._ws.closed:
            await self._ws.send_bytes(message)

    async def recv(self) -> bytes:
        msg = await self._ws.receive()
        if msg.type == WSMsgType.BINARY:
            return msg.data
        elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
            raise ConnectionResetError("WebSocket connection closed")
        raise ConnectionError(f"Unexpected message type: {msg.type}")


class FriKodeServer:
    def __init__(self, workspace_path: str, host: str = "0.0.0.0", port: int = 4000, public_url: Optional[str] = None):
        self.host = host
        self.port = port
        self.public_url = public_url or os.environ.get("PUBLIC_URL") or os.environ.get("APP_URL")
        self.tunnel_manager = get_tunnel_manager(self.port)
        if self.public_url:
            self.tunnel_manager.set_custom_url(self.public_url)

        self.base_workspaces_dir = os.path.abspath(workspace_path)
        self.workspace = Workspace(self.base_workspaces_dir)
        self.code_runner = CodeRunner(self.workspace.root_path)
        self.session_code = generate_session_code()
        self.is_running = False
        self.started_at = time.time()

        # Isolated sessions map: session_code -> {"workspace": Workspace, "code_runner": CodeRunner, "name": str, "code": str}
        self.sessions: Dict[str, Dict[str, Any]] = {
            self.session_code: {
                "workspace": self.workspace,
                "code_runner": self.code_runner,
                "name": self.workspace.name,
                "code": self.session_code,
            }
        }

        # Presence & Signaling state
        # client_id -> {"id", "name", "color", "role", "active_file", "ws"}
        self.peers: Dict[str, Dict[str, Any]] = {}
        self.signaling_sockets: Set[web.WebSocketResponse] = set()

        # Yjs CRDT room management
        self.y_server = WebsocketServer(rooms_ready=True, auto_clean_rooms=False)
        self.initialized_rooms: Set[str] = set()

        # aiohttp app with CORS support for remote and cross-origin access
        @web.middleware
        async def cors_middleware(request: web.Request, handler):
            if request.method == "OPTIONS":
                response = web.Response(status=204)
            else:
                try:
                    response = await handler(request)
                except web.HTTPException as ex:
                    response = ex
                except Exception as ex:
                    logger.error(f"Unhandled error handling {request.path}: {ex}")
                    response = web.json_response({"error": str(ex)}, status=500)

            response.headers["Access-Control-Allow-Origin"] = "*"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Requested-With"
            response.headers["Access-Control-Max-Age"] = "86400"
            return response

        self.app = web.Application(middlewares=[cors_middleware])
        self._setup_routes()

    def _setup_routes(self):
        # API routes
        self.app.router.add_get("/api/session", self.handle_get_session)
        self.app.router.add_post("/api/session/create", self.handle_create_session)
        self.app.router.add_post("/api/session/end", self.handle_end_session)
        self.app.router.add_get("/api/ping", self.handle_ping)
        self.app.router.add_get("/api/tunnel", self.handle_get_tunnel)
        self.app.router.add_post("/api/tunnel", self.handle_manage_tunnel)
        self.app.router.add_post("/api/run", self.handle_run_code)
        
        # Workspace file routes
        self.app.router.add_get("/api/files", self.handle_get_files)
        self.app.router.add_get("/api/file", self.handle_get_file)
        self.app.router.add_post("/api/file/save", self.handle_save_file)
        self.app.router.add_post("/api/file/create", self.handle_create_file)
        self.app.router.add_post("/api/file/rename", self.handle_rename_file)
        self.app.router.add_post("/api/file/delete", self.handle_delete_file)

        # WebSockets
        self.app.router.add_get("/ws/collaboration", self.handle_ws_collaboration)
        self.app.router.add_get("/ws/yjs/{room:.*}", self.handle_ws_yjs)

        # Static assets
        static_dir = os.path.join(os.path.dirname(__file__), "static")
        self.app.router.add_static("/css", os.path.join(static_dir, "css"), show_index=False)
        self.app.router.add_static("/js", os.path.join(static_dir, "js"), show_index=False)
        self.app.router.add_static("/vendor", os.path.join(static_dir, "vendor"), show_index=False)
        self.app.router.add_get("/", self.handle_index)
        self.app.router.add_get("/index.html", self.handle_index)

    async def handle_index(self, request: web.Request) -> web.Response:
        index_path = os.path.join(os.path.dirname(__file__), "static", "index.html")
        return web.FileResponse(
            index_path,
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
                "Expires": "0"
            }
        )

    def get_workspace_for_request(self, request: web.Request) -> Tuple[Workspace, CodeRunner, str]:
        """
        Returns (Workspace, CodeRunner, session_code) scoped to the request.
        Uses X-Session-Code header or session_code query parameter.
        Falls back to active session if unspecified.
        """
        code = request.headers.get("X-Session-Code")
        if not code:
            code = request.query.get("session_code")
        if code:
            clean_code = code.strip().upper()
            if not clean_code.startswith("FRI-"):
                clean_code = f"FRI-{clean_code}"
            for s_code, s_info in self.sessions.items():
                if s_code.upper() == clean_code:
                    return s_info["workspace"], s_info["code_runner"], s_code

            # Check if directory exists on disk for this session
            sessions_parent = os.path.join(tempfile.gettempdir(), "frikode_sessions")
            session_root = os.path.join(sessions_parent, clean_code)
            if os.path.exists(session_root):
                ws = Workspace(session_root)
                runner = CodeRunner(ws.root_path)
                self.sessions[clean_code] = {
                    "workspace": ws,
                    "code_runner": runner,
                    "name": ws.name,
                    "code": clean_code
                }
                return ws, runner, clean_code

        return self.workspace, self.code_runner, self.session_code

    async def handle_ping(self, request: web.Request) -> web.Response:
        ws, _, code = self.get_workspace_for_request(request)
        return web.json_response({
            "status": "ok",
            "server_time": time.time(),
            "session_code": code,
            "workspace_name": ws.name
        })

    async def handle_get_tunnel(self, request: web.Request) -> web.Response:
        status = self.tunnel_manager.get_status()
        status["primary_ip"] = get_primary_ip()
        return web.json_response(status)

    async def handle_manage_tunnel(self, request: web.Request) -> web.Response:
        try:
            try:
                data = await request.json()
            except Exception:
                data = {}

            action = data.get("action", "status")
            provider = data.get("provider", "auto")

            if action == "start":
                url = await asyncio.to_thread(self.tunnel_manager.start, provider=provider)
                if url:
                    self.public_url = url
                status = self.tunnel_manager.get_status()
                await self.broadcast_collaboration({
                    "type": "tunnel_update",
                    "tunnel": status
                })
                return web.json_response(status)

            elif action == "stop":
                await asyncio.to_thread(self.tunnel_manager.stop)
                self.public_url = None
                status = self.tunnel_manager.get_status()
                await self.broadcast_collaboration({
                    "type": "tunnel_update",
                    "tunnel": status
                })
                return web.json_response(status)

            elif action == "set_url":
                custom_url = data.get("url", "").strip()
                if custom_url:
                    url = self.tunnel_manager.set_custom_url(custom_url)
                    self.public_url = url
                status = self.tunnel_manager.get_status()
                await self.broadcast_collaboration({
                    "type": "tunnel_update",
                    "tunnel": status
                })
                return web.json_response(status)

            return web.json_response(self.tunnel_manager.get_status())
        except Exception as e:
            logger.error(f"Error handling tunnel management: {e}", exc_info=True)
            status = self.tunnel_manager.get_status()
            status["error"] = str(e)
            return web.json_response(status)

    async def handle_get_session(self, request: web.Request) -> web.Response:
        ws, _, code = self.get_workspace_for_request(request)
        try:
            ips = get_local_ip_addresses()
            primary_ip = get_primary_ip(ips)
        except Exception as e:
            logger.warning(f"Error discovering local interfaces: {e}")
            ips = [{"ip": "127.0.0.1", "label": "Localhost (Loopback)", "is_primary": True}]
            primary_ip = "127.0.0.1"

        # Determine public URL (from tunnel, env var, or forwarded headers)
        resolved_public_url = self.public_url or self.tunnel_manager.public_url
        if not resolved_public_url:
            forwarded_proto = request.headers.get("X-Forwarded-Proto")
            forwarded_host = request.headers.get("X-Forwarded-Host")
            if forwarded_proto and forwarded_host:
                resolved_public_url = f"{forwarded_proto}://{forwarded_host}"

        return web.json_response({
            "session_code": code,
            "primary_ip": primary_ip,
            "ips": ips,
            "port": self.port,
            "public_url": resolved_public_url,
            "tunnel": self.tunnel_manager.get_status(),
            "workspace_name": ws.name,
            "workspace_path": ws.root_path,
            "peer_count": len(self.peers),
            "is_running": self.is_running,
            "uptime_seconds": round(time.time() - self.started_at, 1)
        })

    async def handle_create_session(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            data = {}

        new_path = data.get("workspace_path")
        init_sample = data.get("init_sample", False)
        template = data.get("template", "")
        custom_code = data.get("session_code")
        files = data.get("files")

        new_code = custom_code or generate_session_code()
        clean_code = new_code.strip().upper()
        if not clean_code.startswith("FRI-"):
            clean_code = f"FRI-{clean_code}"

        # Determine isolated workspace directory for this session
        sessions_parent = os.path.join(tempfile.gettempdir(), "frikode_sessions")
        os.makedirs(sessions_parent, exist_ok=True)
        session_root = os.path.join(sessions_parent, clean_code)

        if new_path and os.path.isabs(new_path) and os.path.exists(new_path):
            session_root = new_path

        sess_workspace = Workspace(session_root)
        sess_runner = CodeRunner(sess_workspace.root_path)

        if template == "blank" or template == "folder":
            sess_workspace.clear()
            if files and isinstance(files, dict):
                sess_workspace.populate_files(files)
        elif init_sample:
            sess_workspace.clear()
            sess_workspace.init_sample_project()
        elif template in ("python", "web", "c"):
            sess_workspace.clear()
            sess_workspace.init_template(template, (new_path and os.path.basename(new_path)) or "Project")
        elif sess_workspace.is_empty():
            sess_workspace.init_sample_project()

        ws_name = (new_path and os.path.basename(new_path)) or sess_workspace.name or "Workspace"
        self.sessions[clean_code] = {
            "workspace": sess_workspace,
            "code_runner": sess_runner,
            "name": ws_name,
            "code": clean_code
        }

        # Set as active
        self.session_code = clean_code
        self.workspace = sess_workspace
        self.code_runner = sess_runner

        # Reset rooms for new workspace
        self.initialized_rooms.clear()

        # Notify connected clients of workspace change
        await self.broadcast_collaboration({
            "type": "workspace_reset",
            "workspace_name": ws_name,
            "session_code": clean_code
        })

        return web.json_response({
            "status": "ok",
            "session_code": clean_code,
            "workspace_name": ws_name,
            "workspace_path": sess_workspace.root_path
        })

    async def handle_end_session(self, request: web.Request) -> web.Response:
        logger.info("Host requested session termination.")
        await self.broadcast_collaboration({
            "type": "session_ended",
            "reason": "The host ended this FriKode session."
        })
        return web.json_response({"status": "session_ended"})

    async def handle_run_code(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            data = {}

        ws, runner, code = self.get_workspace_for_request(request)
        path = data.get("path")
        code_content = data.get("code")
        language = data.get("language", "auto")
        stdin_data = data.get("stdin", "")
        timeout = float(data.get("timeout", 12.0))
        user_name = data.get("user_name", "Someone")

        res = await asyncio.to_thread(
            runner.run,
            path=path,
            code=code_content,
            language=language,
            stdin_data=stdin_data,
            timeout=timeout
        )

        file_label = res.get("file") or path or "code"
        await self.broadcast_collaboration({
            "type": "code_executed",
            "file": file_label,
            "language": res.get("language", "code"),
            "user_name": user_name,
            "status": res.get("status"),
            "exit_code": res.get("exit_code"),
            "duration_ms": res.get("duration_ms", 0),
            "session_code": code
        })

        return web.json_response(res)

    async def handle_get_files(self, request: web.Request) -> web.Response:
        ws, _, _ = self.get_workspace_for_request(request)
        tree = ws.get_tree()
        return web.json_response({
            "workspace_name": ws.name,
            "tree": tree
        })

    async def handle_get_file(self, request: web.Request) -> web.Response:
        ws, _, _ = self.get_workspace_for_request(request)
        rel_path = request.query.get("path")
        if not rel_path:
            return web.json_response({"error": "Path parameter is required"}, status=400)

        try:
            content, language = ws.read_file(rel_path)
            return web.json_response({
                "path": rel_path,
                "content": content,
                "language": language
            })
        except WorkspaceSecurityError as e:
            return web.json_response({"error": str(e)}, status=403)
        except FileNotFoundError:
            return web.json_response({"error": "File not found"}, status=404)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def handle_save_file(self, request: web.Request) -> web.Response:
        try:
            ws, _, code = self.get_workspace_for_request(request)
            data = await request.json()
            rel_path = data.get("path")
            content = data.get("content")
            saved_by = data.get("saved_by", "Peer")

            if not rel_path:
                return web.json_response({"error": "Path is required"}, status=400)

            # Check both rel_path and scoped room in y_server.rooms
            scoped_room = f"{code}/{rel_path}"
            target_room = scoped_room if scoped_room in self.y_server.rooms else rel_path

            if content is None and target_room in self.y_server.rooms:
                room = self.y_server.rooms[target_room]
                content = str(room.ydoc.get_text("content"))

            if content is None:
                content, _ = ws.read_file(rel_path)

            ws.write_file(rel_path, content)

            await self.broadcast_collaboration({
                "type": "file_saved",
                "path": rel_path,
                "saved_by": saved_by,
                "session_code": code,
                "timestamp": time.time()
            })

            return web.json_response({"status": "ok", "path": rel_path})
        except WorkspaceSecurityError as e:
            return web.json_response({"error": str(e)}, status=403)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def handle_create_file(self, request: web.Request) -> web.Response:
        try:
            ws, _, code = self.get_workspace_for_request(request)
            data = await request.json()
            rel_path = data.get("path")
            is_dir = data.get("is_dir", False)
            content = data.get("content", "")

            if not rel_path:
                return web.json_response({"error": "Path is required"}, status=400)

            if is_dir:
                ws.create_folder(rel_path)
            else:
                ws.create_file(rel_path, content)

            await self.broadcast_collaboration({
                "type": "tree_updated",
                "action": "create",
                "path": rel_path,
                "is_dir": is_dir,
                "session_code": code
            })

            return web.json_response({"status": "ok", "path": rel_path})
        except WorkspaceSecurityError as e:
            return web.json_response({"error": str(e)}, status=403)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def handle_rename_file(self, request: web.Request) -> web.Response:
        try:
            ws, _, code = self.get_workspace_for_request(request)
            data = await request.json()
            old_path = data.get("old_path")
            new_path = data.get("new_path")

            if not old_path or not new_path:
                return web.json_response({"error": "Both old_path and new_path are required"}, status=400)

            ws.rename_item(old_path, new_path)

            scoped_old = f"{code}/{old_path}"
            for r in (scoped_old, old_path):
                if r in self.y_server.rooms:
                    del self.y_server.rooms[r]
                self.initialized_rooms.discard(r)

            await self.broadcast_collaboration({
                "type": "tree_updated",
                "action": "rename",
                "old_path": old_path,
                "new_path": new_path,
                "session_code": code
            })

            return web.json_response({"status": "ok", "old_path": old_path, "new_path": new_path})
        except WorkspaceSecurityError as e:
            return web.json_response({"error": str(e)}, status=403)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def handle_delete_file(self, request: web.Request) -> web.Response:
        try:
            ws, _, code = self.get_workspace_for_request(request)
            data = await request.json()
            rel_path = data.get("path")

            if not rel_path:
                return web.json_response({"error": "Path is required"}, status=400)

            ws.delete_item(rel_path)

            scoped_room = f"{code}/{rel_path}"
            for r in (scoped_room, rel_path):
                if r in self.y_server.rooms:
                    del self.y_server.rooms[r]
                self.initialized_rooms.discard(r)

            await self.broadcast_collaboration({
                "type": "tree_updated",
                "action": "delete",
                "path": rel_path,
                "session_code": code
            })

            return web.json_response({"status": "ok", "path": rel_path})
        except WorkspaceSecurityError as e:
            return web.json_response({"error": str(e)}, status=403)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    # -------------------------------------------------------------
    # Signaling & Presence WebSocket
    # -------------------------------------------------------------
    async def handle_ws_collaboration(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=15.0)
        await ws.prepare(request)
        self.signaling_sockets.add(ws)

        client_id: Optional[str] = None

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try:
                        payload = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue

                    msg_type = payload.get("type")

                    if msg_type == "join":
                        client_id = payload.get("id") or f"client_{int(time.time() * 1000)}"
                        name = payload.get("name") or "Anonymous Coder"
                        color = payload.get("color") or "#38bdf8"
                        role = payload.get("role") or "participant"

                        self.peers[client_id] = {
                            "id": client_id,
                            "name": name,
                            "color": color,
                            "role": role,
                            "active_file": None,
                            "joined_at": time.time()
                        }

                        # Send current presence list to all
                        await self.broadcast_peers()
                        # Broadcast join activity
                        await self.broadcast_collaboration({
                            "type": "peer_joined",
                            "peer": self.peers[client_id]
                        }, exclude_ws=ws)

                    elif msg_type == "update_profile":
                        if client_id and client_id in self.peers:
                            old_name = self.peers[client_id]["name"]
                            new_name = (payload.get("name") or old_name).strip() or old_name
                            new_color = payload.get("color") or self.peers[client_id]["color"]
                            new_role = payload.get("role")

                            self.peers[client_id]["name"] = new_name
                            self.peers[client_id]["color"] = new_color

                            if new_role and new_role in ("host", "participant", "peer"):
                                if new_role == "host":
                                    for pid, p in self.peers.items():
                                        if pid != client_id and p.get("role") == "host":
                                            p["role"] = "participant"
                                    self.peers[client_id]["role"] = "host"
                                else:
                                    self.peers[client_id]["role"] = new_role

                            await self.broadcast_peers()
                            if old_name != new_name:
                                await self.broadcast_collaboration({
                                    "type": "activity",
                                    "text": f"{old_name} is now known as {new_name}"
                                })

                    elif msg_type == "transfer_host":
                        target_id = payload.get("target_id")
                        if target_id and target_id in self.peers:
                            old_host_name = self.peers[client_id]["name"] if client_id and client_id in self.peers else "Host"
                            for pid, p in self.peers.items():
                                p["role"] = "participant"
                            self.peers[target_id]["role"] = "host"
                            new_host_name = self.peers[target_id]["name"]

                            await self.broadcast_peers()
                            await self.broadcast_collaboration({
                                "type": "host_transferred",
                                "target_id": target_id,
                                "old_host_name": old_host_name,
                                "new_host_name": new_host_name
                            })
                            await self.broadcast_collaboration({
                                "type": "activity",
                                "text": f"Host position transferred to {new_host_name}"
                            })

                    elif msg_type == "file_focus":
                        if client_id and client_id in self.peers:
                            self.peers[client_id]["active_file"] = payload.get("file")
                            await self.broadcast_peers()

                    elif msg_type == "activity":
                        await self.broadcast_collaboration(payload, exclude_ws=ws)

                    elif msg_type == "chat":
                        await self.broadcast_collaboration(payload)

                elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
                    break
        finally:
            self.signaling_sockets.discard(ws)
            if client_id and client_id in self.peers:
                leaving_peer = self.peers.pop(client_id)
                await self.broadcast_peers()
                await self.broadcast_collaboration({
                    "type": "peer_left",
                    "peer": leaving_peer
                })

        return ws

    async def broadcast_peers(self):
        peer_list = [
            {
                "id": p["id"],
                "name": p["name"],
                "color": p["color"],
                "role": p["role"],
                "active_file": p["active_file"]
            }
            for p in self.peers.values()
        ]
        # Sort so Host is always in first position
        peer_list.sort(key=lambda x: (0 if x.get("role") == "host" else 1, x.get("name", "")))
        await self.broadcast_collaboration({
            "type": "peers_update",
            "peers": peer_list
        })

    async def broadcast_collaboration(self, message: Dict[str, Any], exclude_ws: Optional[web.WebSocketResponse] = None):
        msg_str = json.dumps(message)
        dead = []
        for ws in self.signaling_sockets:
            if ws is exclude_ws or ws.closed:
                continue
            try:
                await ws.send_str(msg_str)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.signaling_sockets.discard(ws)

    # -------------------------------------------------------------
    # Yjs CRDT WebSocket
    # -------------------------------------------------------------
    async def handle_ws_yjs(self, request: web.Request) -> web.WebSocketResponse:
        room_name = request.match_info.get("room", "default")
        ws = web.WebSocketResponse(heartbeat=20.0)
        await ws.prepare(request)

        # Check if room_name is scoped by session: e.g. "FRI-ABCD/main.py"
        ws_obj = self.workspace
        file_path = room_name
        if "/" in room_name:
            prefix, _, sub_path = room_name.partition("/")
            clean_prefix = prefix.strip().upper()
            if not clean_prefix.startswith("FRI-"):
                clean_prefix = f"FRI-{clean_prefix}"
            for s_code, s_info in self.sessions.items():
                if s_code.upper() == clean_prefix:
                    ws_obj = s_info["workspace"]
                    file_path = sub_path
                    break
            else:
                sessions_parent = os.path.join(tempfile.gettempdir(), "frikode_sessions")
                session_root = os.path.join(sessions_parent, clean_prefix)
                if os.path.exists(session_root):
                    ws_obj = Workspace(session_root)
                    file_path = sub_path

        # Initialize document with disk content if opening for the first time
        if room_name not in self.initialized_rooms:
            try:
                content, _ = ws_obj.read_file(file_path)
                room = await self.y_server.get_room(room_name)
                text = room.ydoc.get_text("content")
                with room.ydoc.begin_transaction() as txn:
                    # Clean and insert disk content
                    if len(str(text)) == 0 and len(content) > 0:
                        text.insert(txn, 0, content)
                self.initialized_rooms.add(room_name)
            except Exception as e:
                logger.warning(f"Could not preload YDoc for room '{room_name}': {e}")

        adapter = AiohttpWebsocketAdapter(ws, room_name)

        try:
            # Serve through ypy-websocket
            await self.y_server.serve(adapter)
        except Exception as e:
            logger.debug(f"Yjs WebSocket connection ended for room '{room_name}': {e}")

        return ws

    async def start(self):
        """Starts the FriKode server."""
        self.is_running = True
        runner = web.AppRunner(self.app)
        await runner.setup()
        site = web.TCPSite(runner, self.host, self.port)

        # Start Yjs server background task
        async with anyio.create_task_group() as tg:
            tg.start_soon(self.y_server.start)
            await self.y_server.started.wait()
            try:
                await site.start()
            except OSError as e:
                if e.errno in (48, 98):  # 48 on macOS, 98 on Linux (EADDRINUSE)
                    print("\n" + "!" * 64)
                    print(f"  [ERROR] Port {self.port} is already in use by another process!")
                    print("!" * 64)
                    print(f"  • To free port {self.port}, run:")
                    print(f"      kill -9 $(lsof -t -i:{self.port})")
                    print(f"  • Or run FriKode on a different port:")
                    print(f"      ./run.sh --port {self.port + 1}")
                    print("!" * 64 + "\n")
                    tg.cancel_scope.cancel()
                    return
                raise

            primary_ip = get_primary_ip()
            print("=" * 64)
            print("  FriKode • Collaborative Code Editor")
            print("=" * 64)
            print(f"  • Local Host:      http://localhost:{self.port}")
            if self.public_url:
                print(f"  • Public / Remote: {self.public_url}")
            print(f"  • Wi-Fi Address:   http://{primary_ip}:{self.port}")
            print(f"  • Session Code:    {self.session_code}")
            print(f"  • Workspace:       {self.workspace.root_path}")
            print("=" * 64)
            if self.public_url:
                print("  Share the Public Link with peers anywhere on any network.")
            else:
                print("  Share the Wi-Fi address or session code with peers on the same Wi-Fi.")
            print("  Keep this process running to maintain the collaborative session.")
            print("=" * 64)

            try:
                # Keep running until cancelled
                while self.is_running:
                    await asyncio.sleep(1)
            except asyncio.CancelledError:
                pass
            finally:
                self.y_server.stop()
                await runner.cleanup()


def run_server(
    workspace_path: str = "sample_project",
    host: str = "0.0.0.0",
    port: int = 4000,
    public_tunnel: bool = False,
    public_url: Optional[str] = None
):
    tunnel_mgr = get_tunnel_manager(port=port)
    if public_tunnel and not public_url:
        print("[FriKode] Starting built-in Remote Public Tunnel...")
        public_url = tunnel_mgr.start(provider="auto")
        if public_url:
            print(f"[FriKode] Remote Access Active: {public_url}")
        else:
            print("[FriKode] Warning: Automatic tunnel could not start. Continuing on local Wi-Fi.")

    server = FriKodeServer(
        workspace_path=workspace_path,
        host=host,
        port=port,
        public_url=public_url
    )
    try:
        asyncio.run(server.start())
    except KeyboardInterrupt:
        print("\n[FriKode] Session stopped by user.")
    finally:
        tunnel_mgr.stop()

