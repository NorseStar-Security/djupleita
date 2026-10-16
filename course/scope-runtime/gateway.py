"""Privileged course-network supervisor, separate from researcher-owned processes."""

import argparse
from datetime import datetime, timezone
import json
import http.client
import os
from pathlib import Path
import signal
import socket
import threading

from certificates import Certificates
from control import Journal, start as start_control
from dns_server import start as start_dns
from firewall import healthy, install
from packet_log import PacketLog
from policy import Policy
from proxy import GatewayServer
from action_review import Engine


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", default="/etc/course/scope.json")
    parser.add_argument("--fixtures", action="store_true", help="controlled local integration fixtures only")
    parser.add_argument("--health", action="store_true")
    parser.add_argument("--web-relay", action="store_true", help="inbound authenticated harness UI relay")
    parser.add_argument("--upstream", help="gateway-only upstream DNS resolver")
    parser.add_argument("--review-config", help="gateway-only action-review configuration")
    parser.add_argument("--review-credentials", help="gateway-only credential file, never mounted into research")
    parser.add_argument("--review-database", default="/var/lib/course-review/decisions.sqlite3")
    parser.add_argument("--review-archive-lease", help="private native-collector lease file, never writable by research")
    args = parser.parse_args()
    if args.health:
        ready_path = Path("/run/course-public/ready.json")
        if not healthy() or not ready_path.exists():
            raise SystemExit(1)
        ready = json.loads(ready_path.read_text())
        if ready.get("actionReviewReady"):
            connection = http.client.HTTPConnection("localhost", timeout=1)
            connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.sock.settimeout(1)
            try:
                connection.sock.connect("/run/course-public/control.sock")
                connection.request("GET", "/review/health")
                response = connection.getresponse()
                state = json.loads(response.read(65536))
                if response.status != 200 or state.get("ready") is not True or state.get("reviewHash") != ready.get("reviewHash"):
                    raise SystemExit(1)
            finally:
                connection.close()
        raise SystemExit(0)
    if os.geteuid() != 0:
        raise SystemExit("scope gateway requires its dedicated root/NET_ADMIN container")
    # The public volume survives a stopped exercise; readiness never does.
    Path("/run/course-public/ready.json").unlink(missing_ok=True)

    def terminate(signum, _frame):
        # Container PID 1 must explicitly handle SIGTERM, including monitor failure.
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminate)
    config = json.loads(Path(args.policy).read_text())
    policy = Policy(config)
    journal = Journal(policy, config)
    review = Engine(json.loads(Path(args.review_config).read_text()), policy, journal.instance,
        json.loads(Path(args.review_credentials).read_text()) if args.review_credentials else {},
        args.review_database, network_policy=config, archive_lease=args.review_archive_lease) if args.review_config else None
    lock = threading.Lock()

    def audit(event, **fields):
        record = {"time": datetime.now(timezone.utc).isoformat(), "event": event, "policy": policy.digest, **fields}
        with lock:
            journal.append(record)
            print(json.dumps(record, sort_keys=True), flush=True)

    # Rules survive supervisor failure in the shared network namespace. Never
    # remove them during teardown while research processes may still exist.
    install(policy)
    certificates = Certificates("/run/course-private", "/run/course-public")
    packets = PacketLog(audit)

    def monitor():
        try:
            packets.run()
        except BaseException as error:
            try:
                audit("monitor_failed", error=type(error).__name__)
            finally:
                os.kill(os.getpid(), signal.SIGTERM)

    monitor_thread = threading.Thread(target=monitor, daemon=True)
    monitor_thread.start()
    upstream = args.upstream or next((line.split()[1] for line in Path("/etc/resolv.conf").read_text().splitlines()
        if line.startswith("nameserver") and line.split()[1] != "127.0.0.1"), "1.1.1.1")
    start_dns(policy, audit, upstream)
    if args.fixtures:
        from tests.fixtures import start
        start(certificates)
    server = GatewayServer(("127.0.0.1", 3128), policy, certificates, audit)
    start_control(Path("/run/course-public/control.sock"), journal, lambda: healthy() and monitor_thread.is_alive(), review)
    Path("/run/course-public/policy.json").write_text(json.dumps(config, sort_keys=True))
    Path("/run/course-public/ready.json").write_text(json.dumps({"policy": policy.digest, "uid": 1000, "boundary": "linux-netns-nftables",
        "actionReviewReady": review is not None and review.audit_ready(), "reviewHash": review.review_hash if review else None}))
    audit("ready", boundary="linux-netns-nftables", uid=1000)
    if args.web_relay:
        from relay import start
        start()
    server.serve_forever()


if __name__ == "__main__":
    main()
