"""nftables rules in the course network namespace; no host firewall changes."""

import subprocess


RESEARCH_UID = 1000
PROXY_PORT = 3128


def ruleset(policy):
    """Filter all researcher-owned sockets, including subprocesses and proxy bypasses."""
    lines = ["table inet course_scope {", " chain output {", "  type filter hook output priority -150; policy accept;", f"  meta skuid != {RESEARCH_UID} accept"]
    # Docker's embedded resolver is otherwise an unmonitored DNS egress path.
    lines += ["  ip daddr 127.0.0.11 counter log group 100 snaplen 128 drop"]
    for net in policy.excluded_ips:
        lines.append(f"  {'ip' if net.version == 4 else 'ip6'} daddr {net} counter log group 100 snaplen 128 drop")
    # Local CDP/SDK/PTY control stays in this private namespace. Nothing here
    # reaches the host loopback; gateway listeners are trusted infrastructure.
    lines += ["  ip daddr 127.0.0.0/8 accept", "  ip6 daddr ::1 accept"]
    for net in policy.ips:
        lines.append(f"  {'ip' if net.version == 4 else 'ip6'} daddr {net} counter accept")
    lines += ["  counter log group 100 snaplen 128 drop", " }", "}"]
    return "\n".join(lines) + "\n"


def install(policy):
    """Install before exposing readiness; a failed command never starts the gateway."""
    existing = subprocess.run(["nft", "list", "table", "inet", "course_scope"], capture_output=True)
    # Replace our table atomically on a supervisor restart, without an allow-all gap.
    prefix = "delete table inet course_scope\n" if existing.returncode == 0 else ""
    subprocess.run(["nft", "-f", "-"], input=prefix + ruleset(policy), text=True, check=True)


def healthy():
    result = subprocess.run(["nft", "list", "table", "inet", "course_scope"], capture_output=True, text=True)
    return result.returncode == 0 and "skuid != 1000" in result.stdout and "drop" in result.stdout
