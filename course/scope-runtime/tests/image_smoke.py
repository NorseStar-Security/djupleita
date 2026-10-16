"""Verify a built course image through dsh/headless in a disposable, offline namespace."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import uuid


def owned(command, timeout, check=True):
    """Join the Docker client before cleanup, including timeout and interruption."""
    with subprocess.Popen(command) as child:
        try:
            code = child.wait(timeout=timeout)
        except BaseException:
            child.kill()
            child.wait()
            raise
        if check and code != 0:
            raise subprocess.CalledProcessError(code, command)


def interrupted(signum, _frame):
    """Finish test-resource cleanup before a second graceful stop can interrupt it."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise KeyboardInterrupt(f"image smoke interrupted by signal {signum}")


def inside():
    """Keep the real course plugins; replace only the external model with replay."""
    with tempfile.TemporaryDirectory(prefix="dsh-image-smoke-") as temporary:
        root = Path(temporary)
        env = dict(os.environ, DSH_HOME=str(root / "home"), DSH_TELEMETRY_MODE="DISABLED", DEEPSEEK_API_KEY="")
        cli = ["node", "/opt/dsh/apps/cli/lib/bin.js", "--profile", "headless", "--patch", "/opt/course/profile.patch.yml"]
        config = subprocess.run(cli + ["--dump-config"], env=env, text=True, capture_output=True, timeout=60)
        if config.returncode != 0:
            raise RuntimeError(f"built course configuration exited {config.returncode}\n{config.stdout}\n{config.stderr}")
        for plugin in ("course-network-scope", "course-network-scope-guard", "course-action-review", "course-action-review-guard", "course-recon", "course-recon-tools", "course-browser-playwright"):
            assert plugin in config.stdout, f"course configuration is missing {plugin}"
        print("PASS: built dsh/headless composes the complete course profile", flush=True)

        patch = root / "replay.patch.yml"
        patch.write_text(json.dumps([
            {"id": "session-persistence-jsonl", "config": {"root": str(root / "home" / "sessions"), "compression": "none"}},
            {"id": "llm-deepseek", "disabled": True},
            {"id": "plugin-package-inventory-deepseek", "disabled": True},
            {"id": "session-title-llm", "disabled": True},
            {"insert": [{
                "id": "image-smoke-replay",
                "name": "/opt/dsh/packages/test-support/llm-replay/lib/index.js",
                "config": {
                    "file": "/opt/dsh/snapshots/session/recon-scope/session.v4.jsonl",
                    "providers": [{"id": "deepseek-official", "models": [{"id": "deepseek-v4-flash"}, {"id": "deepseek-v4-pro"}]}],
                },
            }]},
        ]))
        prompt = "Use recon_run to enumerate widgets.test with subfinder, then report the scope denial and stop."
        result = subprocess.run(cli + ["--patch", str(patch), "--json", prompt], env=env, text=True, capture_output=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(f"built headless replay exited {result.returncode}\n{result.stdout}\n{result.stderr}")
        assert "composed sandbox and approval defaults match no preset" not in result.stderr, result.stderr
        rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        assert any(row.get("type") == "tool_call" and row.get("tool") == "recon_run" and row.get("input", {}).get("targets") == ["widgets.test"] for row in rows), result.stdout
        assert any(row.get("type") == "tool_result" and row.get("status") == "error" and "RECON_SCOPE" in row.get("result", "") for row in rows), result.stdout
        logs = list((root / "home").rglob("*.jsonl"))
        durable = [json.loads(line) for path in logs for line in path.read_text().splitlines() if line.strip()]
        assert any(row.get("type") == "tool/call" and row.get("data", {}).get("name") == "recon_run" for row in durable), (logs, result.stderr, [str(path) for path in (root / "home").rglob("*")])
        assert any(row.get("type") == "tool/result" and "RECON_SCOPE" in json.dumps(row.get("data")) for row in durable), logs
        assert any(row.get("type") == "turn/end" and row.get("data", {}).get("reason", {}).get("kind") == "completed" for row in durable), logs
        assert any(row.get("type") == "plugin:action-review-guard/decision" for row in durable), logs
        print("PASS: built course profile records a completed keyless recon run and durable out-of-scope denial", flush=True)


def main():
    """Own the Compose project and delete only its disposable test volumes."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="dsh-course-recon-full")
    parser.add_argument("--gateway-image", required=True)
    parser.add_argument("--context", help="Explicit Docker context; uses named fixtures without Mac bind mounts")
    args = parser.parse_args()
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    docker = ["docker"] + (["--context", args.context] if args.context else [])
    for image in (args.image, args.gateway_image):
        owned(docker + ["image", "inspect", "--format", "{{.Id}}", image], timeout=30)
    directory = Path(__file__).resolve().parent.parent
    project = "dsh-image-smoke-" + uuid.uuid4().hex[:10]
    with tempfile.TemporaryDirectory(prefix="dsh-image-compose-") as temporary:
        if args.context:
            from deployment import compose
            manager, volume = compose(temporary, directory.parents[1], args.context, project, args.gateway_image, args.image, review=True)
            value = json.loads(manager.compose_file.read_text())
            value["services"]["gateway"]["network_mode"] = "none"
            value["services"]["gateway"].pop("ports", None)
            value["services"]["research"]["command"] = ["python3", "-c", Path(__file__).read_text(), "--inside"]
            manager.compose_file.write_text(json.dumps(value))
            base = docker + ["compose", "-p", project, "-f", str(manager.compose_file)]
            try:
                owned(base + ["up", "-d", "--no-build", "--wait", "gateway"], timeout=90)
                owned(base + ["run", "--rm", "--no-deps", "-T", "research"], timeout=180)
            finally:
                try:
                    owned(base + ["logs", "--tail", "12", "gateway"], check=False, timeout=30)
                    owned(base + ["down", "--volumes", "--remove-orphans"], timeout=60)
                finally:
                    owned(docker + ["volume", "rm", volume], timeout=30)
            return
        overlay = Path(temporary) / "compose.json"
        review_config = json.loads((directory / "review.json").read_text())
        review_config["evaluators"] = [{"id": "keyless-fixture", "kind": "fixture", "endpoint": "https://fixture.invalid/", "model": "fixture-v1", "credentialRef": ""}]
        review_config["plugins"] = ["tests.review_fixture"]
        review_path = Path(temporary) / "review.json"
        review_path.write_text(json.dumps(review_config))
        overlay.write_text(json.dumps({"services": {
            "gateway": {"image": args.gateway_image, "network_mode": "none",
                "command": ["--fixtures", "--review-config", "/etc/course/review.json"],
                "volumes": [str(review_path) + ":/etc/course/review.json:ro", "review-audit:/var/lib/course-review"]},
            "research": {
                "image": args.image,
                "command": ["python3", "/checks/image_smoke.py", "--inside"],
                "environment": {"DEEPSEEK_API_KEY": ""},
                "volumes": [str(directory / "tests") + ":/checks:ro"],
            },
        }, "volumes": {"review-audit": {}}}))
        base = ["docker", "compose", "-p", project, "-f", str(directory / "compose.yml"), "-f", str(directory / "verify.compose.yml"), "-f", str(overlay)]
        try:
            owned(base + ["up", "-d", "--no-build", "--wait", "gateway"], timeout=90)
            owned(base + ["run", "--rm", "--no-deps", "-T", "research"], timeout=180)
        finally:
            try:
                owned(base + ["logs", "--tail", "12", "gateway"], check=False, timeout=30)
            finally:
                owned(base + ["down", "--volumes", "--remove-orphans"], timeout=60)


if __name__ == "__main__":
    if sys.argv[1:] == ["--inside"]:
        inside()
    else:
        main()
