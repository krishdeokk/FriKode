"""
Comprehensive FriKode Integration Test Suite
Tests Workspace security, Network helpers, REST API, Signaling WebSockets, and Yjs CRDT endpoints.
"""

import asyncio
import json
import os
import shutil
import tempfile
import unittest
import aiohttp
from aiohttp import web
import anyio
import y_py as Y

from frikode.network import get_local_ip_addresses, get_primary_ip, generate_session_code, normalize_host_address
from frikode.workspace import Workspace, WorkspaceSecurityError
from frikode.server import FriKodeServer


class TestFriKodeNetwork(unittest.TestCase):
    def test_ip_detection(self):
        ips = get_local_ip_addresses()
        self.assertIsInstance(ips, list)
        self.assertGreater(len(ips), 0)
        self.assertIn("ip", ips[0])

        primary = get_primary_ip()
        self.assertIsInstance(primary, str)
        self.assertTrue(len(primary) >= 7)  # At least '1.1.1.1'

    def test_session_code(self):
        code = generate_session_code()
        self.assertTrue(code.startswith("FRI-"))
        self.assertEqual(len(code), 8)  # 'FRI-' (4) + 4 chars

    def test_normalize_address(self):
        self.assertEqual(normalize_host_address("192.168.1.5"), "http://192.168.1.5:4000")
        self.assertEqual(normalize_host_address("192.168.1.5:8080"), "http://192.168.1.5:8080")
        self.assertEqual(normalize_host_address("http://10.0.0.1:4000/"), "http://10.0.0.1:4000")


class TestFriKodeWorkspace(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.ws = Workspace(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_sample_project_init(self):
        self.assertTrue(self.ws.is_empty())
        self.ws.init_sample_project()
        self.assertFalse(self.ws.is_empty())
        tree = self.ws.get_tree()
        names = [item["name"] for item in tree]
        self.assertIn("README.md", names)
        self.assertIn("main.py", names)

    def test_path_traversal_jail(self):
        self.ws.init_sample_project()
        # Relative breakout attempts
        with self.assertRaises(WorkspaceSecurityError):
            self.ws.read_file("../../etc/passwd")

        with self.assertRaises(WorkspaceSecurityError):
            self.ws.read_file("../some_file.txt")

        with self.assertRaises(WorkspaceSecurityError):
            self.ws.write_file("../escape.txt", "payload")

        with self.assertRaises(WorkspaceSecurityError):
            self.ws.delete_item("../")

    def test_file_operations(self):
        self.ws.create_file("test.py", "print('hello')")
        content, lang = self.ws.read_file("test.py")
        self.assertEqual(content, "print('hello')")
        self.assertEqual(lang, "python")

        self.ws.write_file("test.py", "print('updated')")
        content, _ = self.ws.read_file("test.py")
        self.assertEqual(content, "print('updated')")

        self.ws.rename_item("test.py", "renamed.py")
        self.assertTrue(os.path.exists(os.path.join(self.test_dir, "renamed.py")))

        self.ws.delete_item("renamed.py")
        self.assertFalse(os.path.exists(os.path.join(self.test_dir, "renamed.py")))


class TestFriKodeServerIntegration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.ws = Workspace(self.test_dir)
        self.ws.init_sample_project()

        self.port = 4099
        self.server = FriKodeServer(workspace_path=self.test_dir, host="127.0.0.1", port=self.port)
        
        # Start server background task
        self.runner = web.AppRunner(self.server.app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", self.port)
        await self.site.start()
        
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.session = aiohttp.ClientSession()

    async def asyncTearDown(self):
        await self.session.close()
        await self.runner.cleanup()
        shutil.rmtree(self.test_dir, ignore_errors=True)

    async def test_api_session_and_ping(self):
        # Ping
        async with self.session.get(f"{self.base_url}/api/ping") as res:
            self.assertEqual(res.status, 200)
            data = await res.json()
            self.assertEqual(data["status"], "ok")

        # Session
        async with self.session.get(f"{self.base_url}/api/session") as res:
            self.assertEqual(res.status, 200)
            data = await res.json()
            self.assertTrue(data["session_code"].startswith("FRI-"))
            self.assertEqual(data["port"], self.port)

    async def test_file_rest_api(self):
        # List files
        async with self.session.get(f"{self.base_url}/api/files") as res:
            self.assertEqual(res.status, 200)
            data = await res.json()
            self.assertIn("tree", data)
            self.assertGreater(len(data["tree"]), 0)

        # Get file
        async with self.session.get(f"{self.base_url}/api/file?path=main.py") as res:
            self.assertEqual(res.status, 200)
            data = await res.json()
            self.assertIn("calculate_mesh_latency", data["content"])

        # Save file
        new_code = "print('Peer update test')\n"
        async with self.session.post(f"{self.base_url}/api/file/save", json={
            "path": "main.py",
            "content": new_code,
            "saved_by": "TestPeer"
        }) as res:
            self.assertEqual(res.status, 200)

        # Verify saved file
        content, _ = self.ws.read_file("main.py")
        self.assertEqual(content, new_code)

    async def test_collaboration_websocket_signaling(self):
        ws_url = f"ws://127.0.0.1:{self.port}/ws/collaboration"
        async with self.session.ws_connect(ws_url) as ws:
            # Send join
            await ws.send_json({
                "type": "join",
                "id": "peer_1",
                "name": "Sarah",
                "color": "#a855f7",
                "role": "participant"
            })

            # Receive peers_update
            msg = await ws.receive_json(timeout=3.0)
            self.assertEqual(msg["type"], "peers_update")
            peer_names = [p["name"] for p in msg["peers"]]
            self.assertIn("Sarah", peer_names)

            # File focus broadcast
            await ws.send_json({
                "type": "file_focus",
                "file": "main.py"
            })
            msg2 = await ws.receive_json(timeout=3.0)
            self.assertEqual(msg2["type"], "peers_update")
            focused = [p["active_file"] for p in msg2["peers"] if p["id"] == "peer_1"]
            self.assertEqual(focused[0], "main.py")

    async def test_public_url_forwarded_headers(self):
        headers = {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "frikode-demo.koyeb.app"
        }
        async with self.session.get(f"{self.base_url}/api/session", headers=headers) as res:
            self.assertEqual(res.status, 200)
            data = await res.json()
            self.assertEqual(data.get("public_url"), "https://frikode-demo.koyeb.app")


class TestTunnelManager(unittest.TestCase):
    def test_tunnel_availability(self):
        from frikode.tunnel import CloudflareTunnel
        tunnel = CloudflareTunnel(port=4000)
        self.assertIsInstance(CloudflareTunnel.is_available(), bool)
        self.assertEqual(tunnel.port, 4000)
        self.assertIsNone(tunnel.public_url)

    def test_multi_provider_tunnel_manager(self):
        from frikode.tunnel import TunnelManager
        manager = TunnelManager(port=4000)
        providers = manager.get_available_providers()
        self.assertIn("cloudflare", providers)
        self.assertIn("pinggy", providers)
        self.assertIn("localhost_run", providers)
        self.assertIn("custom", providers)
        self.assertTrue(providers["custom"])

        status = manager.get_status()
        self.assertFalse(status["active"])
        self.assertIsNone(status["url"])
        self.assertEqual(status["port"], 4000)

        # Custom URL setting
        url = manager.set_custom_url("https://frikode-peer.example.com")
        self.assertEqual(url, "https://frikode-peer.example.com")
        self.assertTrue(manager.is_active())
        self.assertEqual(manager.public_url, "https://frikode-peer.example.com")
        self.assertEqual(manager.active_provider, "custom")

        # Stop
        manager.stop()
        self.assertFalse(manager.is_active())
        self.assertIsNone(manager.public_url)


if __name__ == "__main__":
    unittest.main()

