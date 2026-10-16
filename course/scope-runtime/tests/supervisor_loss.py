"""A stopped supervisor must not remove the research namespace's kernel policy."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import socket
import sys
import threading


class Handler(BaseHTTPRequestHandler):
    def handle(self):
        self.server.connections += 1


servers = []
threads = []
try:
    for address in ("198.18.0.2", "198.18.0.3"):
        server = ThreadingHTTPServer((address, 18082), Handler)
        server.connections = 0
        servers.append(server)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        threads.append(thread)
    print("ready", flush=True)
    assert sys.stdin.readline() == "probe\n"
    with socket.create_connection(("198.18.0.2", 18082), timeout=2):
        pass
    try:
        with socket.create_connection(("198.18.0.3", 18082), timeout=0.5):
            raise AssertionError("kernel policy disappeared with the supervisor")
    except TimeoutError:
        pass
    try:
        with socket.create_connection(("127.0.0.1", 3128), timeout=1):
            raise AssertionError("supervisor proxy unexpectedly survived")
    except ConnectionRefusedError:
        pass
    print("PASS: supervisor loss leaves direct out-of-scope sockets blocked", flush=True)
finally:
    for server in servers:
        server.shutdown()
        server.server_close()
    for thread in threads:
        thread.join()
assert servers[0].connections > 0 and servers[1].connections == 0
