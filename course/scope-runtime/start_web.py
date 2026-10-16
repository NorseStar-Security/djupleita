"""Start the protected Web profile after the normal UID/capability admission."""

import os
import json
from pathlib import Path
import sys
import subprocess
from urllib.parse import urlparse

# Compose shares the gateway namespace and its scoped DNS resolver.
native = Path("/etc/course/config/native.json")
if native.exists():
    subprocess.run(["node", "/opt/course/bootstrap.mjs", "/opt/dsh", os.environ["DSH_HOME"], str(native)], check=True)
manifest = Path(os.environ["DSH_HOME"]) / "profiles/web/package.json"
manifest.parent.mkdir(parents=True, exist_ok=True)
value = json.loads(manifest.read_text()) if manifest.exists() else {"name": "dsh-profile-web", "private": True, "dependencies": {}}
selected = value.setdefault("dsh", {}).setdefault("profile", {}).get("bundles", [])
value["dsh"]["profile"]["bundles"] = list(dict.fromkeys(json.loads(Path("/etc/course/config/bundles.json").read_text()) + selected))
manifest.write_text(json.dumps(value, indent=2) + "\n")
os.chdir("/workspace")
os.execvp("node", ["node", "/opt/dsh/apps/cli/lib/bin.js", "--profile", "web", "--patch", "/etc/course/config/profile.patch.yml",
                   "--patch", "/opt/dsh/apps/web/tests/pin-browse-picker.overlay.yml", "--no-open", "--host", "127.0.0.1", "--port", "3080",
                   "--public-url", sys.argv[1], "--trusted-host", urlparse(sys.argv[1]).netloc])
