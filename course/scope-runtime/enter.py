"""Admit only an unprivileged course process after the network supervisor is ready."""

import json
import os
from pathlib import Path
import subprocess
import sys


if sys.platform != "linux" or os.geteuid() != 1000:
    raise SystemExit("course tools must run as UID 1000 inside the dedicated Linux runtime")
status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
if any(int(status[key].strip(), 16) for key in ("CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd")) or status["NoNewPrivs"].strip() != "1":
    raise SystemExit("course tools require dropped capabilities and no-new-privileges")
ready = json.loads(Path("/run/course-public/ready.json").read_text())
if ready.get("uid") != os.geteuid() or ready.get("boundary") != "linux-netns-nftables":
    raise SystemExit("course network boundary is not ready")
database = Path.home() / ".pki/nssdb"
database.mkdir(parents=True, exist_ok=True)
if not (database / "cert9.db").exists():
    subprocess.run(["certutil", "-N", "-d", "sql:" + str(database), "--empty-password"], check=True)
subprocess.run(["certutil", "-D", "-d", "sql:" + str(database), "-n", "DSH course CA"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
subprocess.run(["certutil", "-A", "-d", "sql:" + str(database), "-n", "DSH course CA", "-t", "C,,", "-i", "/run/course-public/ca.crt"], check=True)
print("course scope policy: " + ready["policy"], file=sys.stderr)
os.execvp(sys.argv[1], sys.argv[1:])
