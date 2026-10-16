"""Instructor-host operations. Never mounted into research with Docker access."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

from policy import Policy
from action_review import configuration as review_configuration, digest as review_digest


def validate_configuration(config, *, complete=False):
    policy = Policy(config["policy"])
    if config.get("actionReview") is not None:
        review_configuration(config["actionReview"], complete=complete)
    elif complete:
        raise ValueError("Configure action review before applying isolated research")
    if complete and (policy.operations is None or not config["policy"]["operations"]["requireMediatedHttp"]):
        raise ValueError("Isolated research requires mediated HTTP operation policy and request budgets")
    return policy


def atomic(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True))
    temporary.chmod(0o600)
    temporary.replace(path)


class Manager:
    def __init__(self, root, source, context):
        self.root = Path(root)
        self.source = Path(source)
        self.docker = ["docker", "--context", context]
        self.project = "dsh-course-ui"
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.compose_file = self.root / "compose.json"

    def run(self, args, *, data=None, timeout=120, capture=True):
        result = subprocess.run(self.docker + args, input=data, text=True,
                                capture_output=capture, timeout=timeout)
        if result.returncode:
            # Runtime logs contain launch tokens; never use them as diagnostics.
            diagnostic = result.stderr[-4000:] if capture and args[0] not in ("logs",) else ""
            raise RuntimeError(f"Docker {args[0]} failed ({result.returncode}): {diagnostic}")
        return (result.stdout + (result.stderr if args[0] == "logs" else "")) if capture else ""

    def compose(self, *args, **kwargs):
        return self.run(["compose", "-p", self.project, "-f", str(self.compose_file), *args], **kwargs)

    def report(self, phase, **values):
        previous = json.loads((self.root / "status.json").read_text()) if (self.root / "status.json").exists() else {}
        atomic(self.root / "status.json", {**previous, "phase": phase, "error": None, **values})

    def stop(self):
        self.report("stopping", researchStopped=False)
        if self.compose_file.exists():
            # Stop the complete research cgroup before touching the gateway or policy.
            self.compose("stop", "--timeout", "15", "research")
            self.compose("stop", "--timeout", "5", "gateway")
            self.compose("down", "--remove-orphans")
        (self.root / "backend.json").unlink(missing_ok=True)
        self.report("stopped", healthy=False, actionReviewReady=False, researchStopped=True)

    def prepare(self):
        self.stop()
        self.report("preparing")
        commit = subprocess.run(["git", "-C", str(self.source), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        if not re.fullmatch(r"[0-9a-f]{7,40}", commit):
            raise RuntimeError("The research image requires a source Git commit for client build metadata")
        for image, dockerfile in (("dsh-course-gateway:local", "Dockerfile.gateway"), ("dsh-course-research:local", "Dockerfile.research")):
            self.report("preparing", detail=f"Building {image}; native log: {self.root / 'build.log'}")
            with (self.root / "build.log").open("a") as log:
                result = subprocess.run(self.docker + ["build", "--platform", "linux/arm64", "--build-arg", "DSH_CLIENT_COMMIT_HASH=" + commit, "-t", image, "-f",
                    str(self.source / "course/scope-runtime" / dockerfile), str(self.source)], stdout=log, stderr=subprocess.STDOUT, timeout=3600)
            if result.returncode:
                raise RuntimeError(f"Image build failed. Review {self.root / 'build.log'}, correct the build error, and choose Build ARM runtime again. Research remains stopped.")
        self.inspect_versions()
        self.report("stopped", prepared=True, healthy=False)

    def inspect_versions(self):
        versions = {}
        releases = json.loads((self.source / "course/scope-runtime/recon-versions.json").read_text())
        for name, release in releases.items():
            # Version banners may be on either stream. No shell or network is needed.
            result = subprocess.run(self.docker + ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
                "--tmpfs", "/home/course:uid=1000,gid=1000,mode=0700", "--tmpfs", "/tmp:mode=1777",
                "--user", "1000:1000", "--entrypoint", name, "dsh-course-research:local", "-version"], capture_output=True, text=True, check=True, timeout=30)
            output = result.stdout + result.stderr
            if not re.search(r"(?<![\d.])v?" + re.escape(release["version"]) + r"(?![\d.])", output):
                raise RuntimeError(f"Installed {name} version differs from the pinned image release")
            versions[name] = release["version"]
        atomic(self.root / "versions.json", versions)

    def configuration(self, request):
        config, revision = request["config"], request["revision"]
        policy = validate_configuration(config, complete=True)
        private_features = request.get("features", {})
        if private_features.get("trajectories") is not True:
            raise ValueError("Isolated research requires the native local trajectory collector and projection")
        review_credentials = private_features.get("reviewCredentials", {})
        for evaluator in config["actionReview"]["evaluators"]:
            reference = evaluator["credentialRef"]
            if reference and (not isinstance(review_credentials.get(reference), str) or not review_credentials[reference]):
                raise ValueError("Action evaluator credential is missing: " + reference)
        snapshots = self.root / "revisions"
        snapshots.mkdir(mode=0o700, exist_ok=True)
        snapshot = snapshots / f"{revision}.json"
        if snapshot.exists() and json.loads(snapshot.read_text()) != config:
            raise RuntimeError("An immutable configuration revision cannot be replaced")
        if not snapshot.exists():
            atomic(snapshot, config)
        # Explicit allowlist: gateway-only keys must never enter native.json in research.
        features = {name: private_features[name] for name in ("bundles", "patches", "credentials", "trajectories")}
        # Model settings and stored keys can change without widening the immutable network policy.
        feature_digest = hashlib.sha256(json.dumps(features, sort_keys=True).encode()).hexdigest()[:16]
        volume = f"dsh-course-ui-config-{revision}-{feature_digest}"
        review_hash = review_digest(config["actionReview"], policy.digest)
        private_digest = hashlib.sha256(json.dumps(review_credentials, sort_keys=True).encode()).hexdigest()[:16]
        review_volume = f"dsh-course-ui-review-{revision}-{review_hash[:16]}-{private_digest}"
        patch = [
            {"id": "sandbox-policy", "config": {"mode": "danger-full-access", "workspaceRoot": "/workspace"}},
            {"id": "permission", "config": {"defaultPreset": "protected", "presets": {
                "protected": {"sandbox": "danger-full-access", "approval": "ask", "name": "Protected",
                              "description": "Research inside the protected environment; requests still require approval."}}}},
            {"id": "session-log-deepseek", "config": {"enabled": False}},
            *([{"id": "llm-pi-ai", "config": {"providers": {"openai": {"apiKeyEnv": "OPENAI_API_KEY"}}}}] if config["forwardOpenAIKey"] and not features["patches"] else []),
            {"id": "course-runtime", "config": {"role": "research"}},
            {"insert": [
                {"id": "course-network-scope", "name": "@deepseek-ai/dsh-experimental-network-scope-linux", "config": config["provider"]},
                {"id": "course-network-scope-guard", "name": "@deepseek-ai/dsh-experimental-network-scope-guard", "config": config["guard"]},
                {"id": "course-action-review", "name": "@deepseek-ai/dsh-experimental-action-review-linux", "config": {
                    "socketPath": config["provider"]["socketPath"], "timeoutMs": config["actionReview"]["timeoutSeconds"] * 1000 + 5000,
                    "maxResponseBytes": config["actionReview"]["maxResponseBytes"], "maxActionBytes": config["actionReview"]["maxInputBytes"]}},
                {"id": "course-action-review-guard", "name": "@deepseek-ai/dsh-experimental-action-review-guard"},
                *([{"id": "course-trajectory-viewer", "name": "/opt/dsh/packages/experimental/trajectory-viewer/lib/native-management.js"}]
                  if features["trajectories"] else []),
                *([
                    {"id": "course-recon", "name": "@deepseek-ai/dsh-experimental-recon-projectdiscovery", "config": config["recon"]},
                    {"id": "course-recon-tools", "name": "@deepseek-ai/dsh-experimental-recon-tools"},
                ] if request["reconEnabled"] else []),
                {"id": "course-browser", "name": "@deepseek-ai/dsh-browser-use"},
                {"id": "course-browser-playwright", "name": "@deepseek-ai/dsh-experimental-browser-use-playwright-mcp", "config": {"mode": "launch", "headless": True, "executablePath": "/opt/course/chromium.sh"}},
            ]},
        ]
        self.run(["volume", "create", volume])
        seed = """import json,sys,pathlib
r=pathlib.Path('/config')
for k,v in json.load(sys.stdin).items():
 p=r/k
 if p.exists():
  if p.read_text()!=v: raise RuntimeError('Generated configuration changed; save a new draft revision before applying')
 else:
  p.write_text(v)
  p.chmod(0o444)
"""
        self.run(["volume", "create", review_volume])
        self.run(["run", "--rm", "-i", "--network", "none", "--cap-drop", "ALL",
                  "--mount", f"type=volume,source={review_volume},target=/config", "--entrypoint", "python3",
                  "dsh-course-gateway:local", "-c", seed],
                 data=json.dumps({"review.json": json.dumps(config["actionReview"]), "credentials.json": json.dumps(review_credentials)}))
        self.run(["run", "--rm", "-i", "--network", "none", "--cap-drop", "ALL",
                  "--mount", f"type=volume,source={volume},target=/config", "--entrypoint", "python3",
                  "dsh-course-gateway:local", "-c", seed],
                 data=json.dumps({"scope.json": json.dumps(config["policy"]), "profile.patch.yml": json.dumps(patch),
                                  "resolv.conf": "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n",
                                  "native.json": json.dumps(features),
                                  "bundles.json": json.dumps(list(dict.fromkeys(features["bundles"] + ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-experimental-network-scope-bundle"] + (["@deepseek-ai/dsh-experimental-recon-bundle"] if request["reconEnabled"] else []))))}))
        environment = {
            "HOME": "/home/course", "DSH_HOME": "/home/course/.dsh", "DSH_TELEMETRY_MODE": "DISABLED",
            "NARB_NATIVE_CACHE_DIR": "/home/course/.cache/dsh-native",
            "OPENAI_API_KEY": "${DSH_COURSE_OPENAI_API_KEY:-}" if config["forwardOpenAIKey"] else "",
            **{key: "http://127.0.0.1:3128" for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")},
            "NO_PROXY": "", "no_proxy": "", "NODE_EXTRA_CA_CERTS": "/run/course-public/ca.crt",
            "SSL_CERT_FILE": "/run/course-public/combined.pem", "REQUESTS_CA_BUNDLE": "/run/course-public/combined.pem",
            "CURL_CA_BUNDLE": "/run/course-public/combined.pem",
        }
        compose = {"services": {
            "gateway": {"image": "dsh-course-gateway:local", "cap_drop": ["ALL"], "cap_add": ["NET_ADMIN", "NET_BIND_SERVICE"],
                "security_opt": ["no-new-privileges:true"], "read_only": True,
                "command": ["--policy", "/etc/course/config/scope.json", "--web-relay", "--review-config", "/etc/course/review/review.json",
                            "--review-credentials", "/etc/course/review/credentials.json", "--review-database", "/var/lib/course-review/decisions.sqlite3",
                            "--review-archive-lease", "/run/course-private/archive-until"],
                "ports": ["127.0.0.1::3082"], "dns": ["127.0.0.1"], "network_mode": "bridge",
                "volumes": [f"{volume}:/etc/course/config:ro", f"{review_volume}:/etc/course/review:ro", "review-audit:/var/lib/course-review", "public:/run/course-public"],
                "tmpfs": ["/run/course-private:mode=0700", "/tmp"],
                "healthcheck": {"test": ["CMD", "python3", "/opt/course/gateway.py", "--health"], "interval": "2s", "timeout": "2s", "retries": 30}},
            "research": {"image": "dsh-course-research:local", "user": "1000:1000", "cap_drop": ["ALL"],
                "security_opt": ["no-new-privileges:true"], "network_mode": "service:gateway", "read_only": True,
                "shm_size": "1gb", "environment": environment,
                "volumes": [f"{volume}:/etc/course/config:ro", "public:/run/course-public:ro", "home:/home/course", "workspace:/workspace"],
                "tmpfs": ["/tmp:mode=1777"],
                "command": ["python3", "/opt/course/start_web.py", request["publicUrl"]],
            }}, "volumes": {"public": {}, "home": {}, "workspace": {}, "review-audit": {}, volume: {"external": True}, review_volume: {"external": True}}}
        atomic(self.compose_file, compose)
        return policy.digest

    def apply(self, request):
        # Validate all mandatory controls before stopping a healthy prior deployment.
        policy = validate_configuration(request["config"], complete=True)
        if request.get("features", {}).get("trajectories") is not True:
            raise ValueError("Isolated research requires the native local trajectory collector and projection")
        for evaluator in request["config"]["actionReview"]["evaluators"]:
            reference = evaluator["credentialRef"]
            if reference and not request["features"].get("reviewCredentials", {}).get(reference):
                raise ValueError("Action evaluator credential is missing: " + reference)
        review_hash = review_digest(request["config"]["actionReview"], policy.digest)
        self.stop()
        self.report("starting")
        expected = self.configuration(request)
        self.compose("up", "-d", "--wait", "gateway")
        gateway = self.compose("ps", "-q", "gateway").strip()
        ready = json.loads(self.run(["exec", gateway, "cat", "/run/course-public/ready.json"]))
        if ready.get("policy") != expected:
            raise RuntimeError("Gateway policy hash differs from the saved policy")
        if ready.get("actionReviewReady") is not True or ready.get("reviewHash") != review_hash:
            raise RuntimeError("Gateway action review is not ready for the saved policy")
        self.compose("up", "-d", "research")
        research = self.compose("ps", "-q", "research").strip()
        for _ in range(180):
            logs = self.run(["logs", research])
            tokens = re.findall(r"[?&]token=([A-Za-z0-9_-]+)", logs)
            if tokens:
                address = self.compose("port", "gateway", "3082").strip()
                if not re.fullmatch(r"127\.0\.0\.1:\d+", address):
                    raise RuntimeError("Course UI relay is not bound to host loopback")
                atomic(self.root / "backend.json", {"origin": "http://" + address, "token": tokens[-1]})
                self.report("running", healthy=True, actionReviewReady=False, reviewHash=review_hash, researchStopped=False, appliedRevision=request["revision"], policyHash=expected, prepared=True)
                atomic(self.root / "applied.json", {"revision": request["revision"], "config": request["config"], "policyHash": expected})
                return
            if self.run(["inspect", "--format", "{{.State.Running}}", research]).strip() != "true":
                diagnostic = self.root / "research-startup.log"
                diagnostic.touch(mode=0o600)
                diagnostic.chmod(0o600)
                diagnostic.write_text(logs)
                raise RuntimeError(f"Research backend exited during startup; review the private native log at {diagnostic}")
            time.sleep(1)
        raise RuntimeError("Research backend did not become ready within 180 seconds")

    def archive_ready(self, deployment):
        state = self.status()
        if state["phase"] != "running" or state.get("healthy") is not True:
            raise RuntimeError("Cannot renew collection for an unavailable runtime")
        if (not isinstance(deployment, dict) or set(deployment) != {"revision", "policyHash", "reviewHash"}
                or type(deployment["revision"]) is not int
                or not all(isinstance(deployment[key], str) and len(deployment[key]) == 64 for key in ("policyHash", "reviewHash"))
                or deployment["revision"] != state.get("appliedRevision")
                or any(deployment[key] != state.get(key) for key in ("policyHash", "reviewHash"))):
            raise RuntimeError("Native collection belongs to a different isolated deployment")
        gateway = self.compose("ps", "-q", "gateway").strip()
        # This executes only through the instructor-owned Docker daemon, not the worker socket.
        script = "import json,pathlib,time; c=json.loads(pathlib.Path('/etc/course/review/review.json').read_text()); p=pathlib.Path('/run/course-private/archive-until'); p.write_text(str(time.monotonic()+c['archiveLeaseSeconds'])); p.chmod(0o600)"
        self.run(["exec", gateway, "python3", "-c", script])
        self.report("running", actionReviewReady=True)

    def status(self):
        value = json.loads((self.root / "status.json").read_text()) if (self.root / "status.json").exists() else {"phase": "stopped", "prepared": False, "healthy": False}
        if value["phase"] == "running":
            try:
                rows = self.compose("ps", "--format", "json")
                services = [json.loads(line) for line in rows.splitlines() if line.strip()]
                if not any(row.get("Service") == "gateway" and row.get("Health") == "healthy" for row in services) or not any(row.get("Service") == "research" and row.get("State") == "running" for row in services):
                    self.stop()
                    self.report("failed", healthy=False, actionReviewReady=False, error="The isolated backend lost gateway, reviewer, or process health; research was stopped.")
                    value = json.loads((self.root / "status.json").read_text())
            except (OSError, subprocess.SubprocessError, RuntimeError) as error:
                value = {**value, "healthy": False, "actionReviewReady": False, "error": str(error)}
        return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["validate", "status", "prepare", "apply", "stop", "recover", "archive-ready"])
    parser.add_argument("--state", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--context", required=True)
    args = parser.parse_args()
    manager = Manager(args.state, args.source, args.context)
    # Every lifecycle mutation, including recovery after a crash, has one owner.
    lock = (manager.root / "operation.lock").open("a")
    if args.action != "validate":
        if args.action == "status":
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                path = manager.root / "status.json"
                print(path.read_text() if path.exists() else json.dumps({"phase": "stopped", "healthy": False, "prepared": False}))
                return
        else:
            fcntl.flock(lock, fcntl.LOCK_EX)
    def interrupted(_number, _frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise RuntimeError("Runtime operation interrupted; research remains stopped.")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        if args.action == "validate":
            value = json.load(sys.stdin)
            policy = validate_configuration(value["config"], complete=value.get("complete") is True) if isinstance(value, dict) and "config" in value else Policy(value)
            print(json.dumps({"policyHash": policy.digest}))
        elif args.action == "status":
            print(json.dumps(manager.status()))
        elif args.action == "archive-ready":
            manager.archive_ready(json.load(sys.stdin))
        elif args.action == "recover":
            if manager.status()["phase"] in ("starting", "stopping", "preparing"):
                manager.stop()
                manager.report("failed", error="Interrupted runtime operation; research remains stopped. Review settings and apply again.")
        elif args.action == "apply":
            manager.apply(json.load(sys.stdin))
        else:
            getattr(manager, args.action)()
    except (ValueError, OSError, subprocess.SubprocessError, RuntimeError) as error:
        if args.action not in ("validate", "status"):
            try:
                manager.stop()
            except (OSError, subprocess.SubprocessError, RuntimeError):
                # The daemon may be unavailable; retain the failure without claiming a stop.
                pass
            manager.report("failed", healthy=False, error=str(error))
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
