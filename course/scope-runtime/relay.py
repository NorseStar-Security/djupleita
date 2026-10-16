"""Inbound UI transport only; research egress still passes the existing firewall."""

import select
import socket
import socketserver
import threading


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with socket.create_connection(("127.0.0.1", 3080), timeout=10) as upstream:
                upstream.settimeout(None)
                peers = (self.request, upstream)
                while True:
                    readable, _, _ = select.select(peers, [], [], 60)
                    if not readable:
                        continue
                    for source in readable:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is self.request else self.request).sendall(data)
        except (OSError, TimeoutError):
            # A stopped/restarting research listener closes this inbound connection.
            return


def start():
    """Bind the container's concrete interface, never the host or a wildcard."""
    address = socket.gethostbyname(socket.gethostname())
    server = socketserver.ThreadingTCPServer((address, 3082), Relay)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
