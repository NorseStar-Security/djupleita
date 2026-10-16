"""Build and verify a disposable course namespace without touching exercise volumes."""

import argparse
import json
import sys
import tempfile
from pathlib import Path
import selectors
import subprocess
import uuid


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--context')
parser.add_argument('--prebuilt', action='store_true', help='Use ARM UI images and named configuration volumes, with no Mac mounts')
args = parser.parse_args()
directory = Path(__file__).resolve().parent
project = "dsh-course-scope-test-" + uuid.uuid4().hex[:10]
docker = ["docker"] + (["--context", args.context] if args.context else [])
base = [*docker, "compose", "-p", project, "-f", str(directory / "compose.yml"), "-f", str(directory / "verify.compose.yml")]

fixture_root = tempfile.TemporaryDirectory(prefix='dsh-course-verify-') if args.prebuilt else None
fixture_manager = None
fixture_volume = None
if args.prebuilt:
    sys.path.insert(0, str(directory / 'tests'))
    from deployment import compose
    fixture_manager, fixture_volume = compose(fixture_root.name, directory.parent.parent, args.context or 'default', project, 'dsh-course-gateway:local', 'dsh-course-research:local')
    base = [*docker, 'compose', '-p', project, '-f', str(fixture_manager.compose_file)]


def run(args, capture=False):
    return subprocess.run(base + args, check=True, text=True, capture_output=capture)


try:
    if not args.prebuilt:
        run(["build"])
    run(["up", "-d", "--wait"])
    run(["exec", "-T", "research", "python3", "/opt/course/tests/client.py"])
    counts = json.loads(run(["exec", "-T", "gateway", "python3", "-c", "from pathlib import Path; print(Path('/run/course-private/test-counts.json').read_text())"], capture=True).stdout)
    for key in ["domain-forbidden", "raw-forbidden", "v6-forbidden"]:
        for suffix in ("", ":connections", ":datagrams"):
            assert counts[key + suffix] == 0, counts
    for key in ["domain-allowed", "raw-allowed", "v6-allowed"]:
        assert counts[key] > 0, counts
    logs = run(["logs", "--no-log-prefix", "gateway"], capture=True).stdout
    records = [json.loads(line) for line in logs.splitlines() if line.startswith("{")]
    assert any(item.get("transport") == "kernel" and item.get("ip") == "198.18.0.3" for item in records), logs
    assert any(item.get("transport") == "kernel" and item.get("ip") == "fd31::3" for item in records), logs
    assert any(item.get("transport") == "kernel" and item.get("ip") == "127.0.0.11" and item.get("port") == 53 for item in records), logs
    assert any(item.get("transport") == "proxy" and item.get("host") == "widgets.test" and item["event"] == "denied" for item in records), logs
    for key in ["raw-allowed", "v6-allowed"]:
        assert counts[key + ":datagrams"] > 0, counts
    print("PASS: forbidden request/connection/datagram counts are zero; positive controls and kernel/proxy audit events verified")
    print(json.dumps(counts, sort_keys=True))
    # The counter oracle must detect a real policy regression, not just stay zero.
    run(["exec", "-T", "gateway", "nft", "insert", "rule", "inet", "course_scope", "output", "meta", "skuid", "1000", "ip", "daddr", "198.18.0.3", "accept"])
    run(["exec", "-T", "research", "curl", "--noproxy", "*", "-fsS", "--max-time", "2", "http://198.18.0.3:18080/negative-control"], capture=True)
    broken = json.loads(run(["exec", "-T", "gateway", "python3", "-c", "from pathlib import Path; print(Path('/run/course-private/test-counts.json').read_text())"], capture=True).stdout)
    assert broken["raw-forbidden"] > 0 and broken["raw-forbidden:connections"] > 0, broken
    policy_path = '/etc/course/config/scope.json' if args.prebuilt else '/etc/course/scope.json'
    run(["exec", "-T", "gateway", "python3", "-c", f"import json; from pathlib import Path; from firewall import install; from policy import Policy; install(Policy(json.loads(Path({policy_path!r}).read_text())))"])
    print("PASS: deliberate test-only firewall regression is visible to the destination counters")
    child = subprocess.Popen(base + ["exec", "-T", "research", "python3", "/opt/course/tests/supervisor_loss.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        with selectors.DefaultSelector() as ready:
            ready.register(child.stdout, selectors.EVENT_READ)
            assert ready.select(timeout=15), "supervisor-loss fixture did not become ready"
        assert child.stdout.readline().strip() == "ready"
        gateway_id = run(["ps", "-q", "gateway"], capture=True).stdout.strip()
        run(["stop", "--timeout", "2", "gateway"])
        stopped = subprocess.run([*docker, "inspect", "--format", "{{.State.ExitCode}}", gateway_id], check=True, capture_output=True, text=True)
        assert stopped.stdout.strip() == "143", stopped.stdout
        output, errors = child.communicate("probe\n", timeout=15)
        assert child.returncode == 0, (child.returncode, output, errors)
        print(output.strip())
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
    run(["stop", "research"])
    # Exercise the actual monitor-failure path with the supervisor as container PID 1.
    failure = subprocess.run(base + ["run", "--rm", "--no-deps", "-T", "--entrypoint", "python3", "gateway", "-c", "import gateway; gateway.PacketLog.run = lambda self: (_ for _ in ()).throw(RuntimeError('test monitor failure')); gateway.main()", "--policy", policy_path], capture_output=True, text=True, timeout=30)
    assert failure.returncode == 143 and '"event": "monitor_failed"' in failure.stdout, (failure.returncode, failure.stdout, failure.stderr)
    print("PASS: monitor failure terminates the supervisor as container PID 1")
finally:
    run(["logs", "--tail", "12", "gateway"])
    run(["down", "--volumes", "--remove-orphans"])
    if fixture_volume:
        fixture_manager.run(['volume', 'rm', fixture_volume])
        fixture_root.cleanup()
