"""Controlled allowed/forbidden servers. Only the supervisor can read their counters."""

import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import struct
import subprocess
import threading


counts = {}
lock = threading.Lock()


def increment(identity):
    with lock:
        counts[identity] = counts.get(identity, 0) + 1
        Path("/run/course-private/test-counts.json").write_text(json.dumps(counts))


class Server(ThreadingHTTPServer):
    tls = None

    def get_request(self):
        connection, address = super().get_request()
        increment(self.identity + ":connections")
        if self.tls:
            try:
                connection = self.tls.wrap_socket(connection, server_side=True)
            except BaseException:
                connection.close()
                raise
        return connection, address


class Fixture(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_GET(self):
        increment(self.server.identity)
        if self.headers.get("Upgrade", "").lower() == "websocket":
            key = self.headers["Sec-WebSocket-Key"]
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            self.wfile.flush()
            header = self.rfile.read(2)
            if len(header) == 2:
                size = header[1] & 127
                if size < 126:
                    mask = self.rfile.read(4)
                    data = self.rfile.read(size)
                    body = bytes(value ^ mask[index % 4] for index, value in enumerate(data))
                    self.wfile.write(bytes([0x81, len(body)]) + body)
                    self.wfile.flush()
            self.close_connection = True
            return
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "https://widgets.test:18443/forbidden")
            body = b"redirect"
        elif self.path == "/page":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            body = b'''<!doctype html><h1>Allowed lab page</h1>
              <a id="outside" href="https://widgets.test:18443/click">Outside</a>
              <button id="popup" onclick="window.open('https://widgets.test:18443/popup')">Popup</button>
              <iframe src="https://widgets.test:18443/frame"></iframe>
              <img src="https://widgets.test:18443/image">
              <script src="https://widgets.test:18443/script"></script>
              <script>
                window.results = {};
                fetch('/ok').then(r=>r.text()).then(t=>results.allowed=t);
                fetch('https://widgets.test:18443/fetch').then(r=>results.outside=r.status).catch(()=>results.outside='blocked');
                const good = new WebSocket('wss://acme.test:18443/socket');
                good.onopen=()=>good.send('echo'); good.onmessage=e=>{results.websocket=e.data;good.close()};
                const bad = new WebSocket('wss://widgets.test:18443/socket');
                bad.onerror=()=>results.badWebsocket='blocked';
                navigator.serviceWorker.addEventListener('message', e=>{results.workerOutside=e.data.workerOutside});
                navigator.serviceWorker.register('/worker.js').then(()=>results.worker='registered').catch(()=>results.worker='unavailable');
              </script>'''
        elif self.path == "/worker.js":
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            body = b'''self.addEventListener('install', e=>e.waitUntil((async()=>{
              let workerOutside;
              try {const r=await fetch('https://widgets.test:18443/worker');workerOutside='responded:'+r.status}
              catch {workerOutside='blocked'}
              for (const client of await self.clients.matchAll({includeUncontrolled:true})) client.postMessage({workerOutside});
            })()));'''
        else:
            self.send_response(200)
            body = b"allowed"
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.do_GET()


class IPv6Server(Server):
    address_family = socket.AF_INET6


def udp(address, identity):
    sock = socket.socket(socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((address, 18081))

    def serve():
        with sock:
            while True:
                data, sender = sock.recvfrom(2048)
                increment(identity + ":datagrams")
                sock.sendto(data, sender)

    threading.Thread(target=serve, daemon=True).start()


def start(certificates):
    addresses = [("198.18.0.2", "raw-allowed"), ("198.18.0.3", "raw-forbidden"), ("198.18.0.4", "domain-allowed"), ("198.18.0.5", "domain-forbidden"), ("fd31::2", "v6-allowed"), ("fd31::3", "v6-forbidden")]
    for address, identity in addresses:
        version = 6 if ":" in address else 4
        subprocess.run(["ip", f"-{version}", "addr", "add", f"{address}/{128 if version == 6 else 32}", "dev", "lo"], check=True)
        counts[identity] = 0
        counts[identity + ":connections"] = 0
        counts[identity + ":datagrams"] = 0
        udp(address, identity)
        server = (IPv6Server if version == 6 else Server)((address, 18080), Fixture)
        server.identity = identity
        threading.Thread(target=server.serve_forever, daemon=True).start()
        if identity.startswith("domain-"):
            name = "acme.test" if identity == "domain-allowed" else "widgets.test"
            tls = Server((address, 18443), Fixture)
            tls.identity = identity
            tls.tls = certificates.context(name)
            threading.Thread(target=tls.serve_forever, daemon=True).start()
    Path("/run/course-private/test-counts.json").write_text(json.dumps(counts))
