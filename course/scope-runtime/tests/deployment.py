"""Test-only named-volume fixtures, deliberately separate from course Apply admission."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from manage import Manager, atomic


def compose(root, source, context, project, gateway_image, research_image, *, review=False):
    manager = Manager(root, source, context)
    manager.project = project
    directory = Path(source) / "course/scope-runtime"
    volume = project + "-fixture-config"
    files = {"scope.json": (directory / "tests/scope.json").read_text()}
    if review:
        config = json.loads((directory / "review.json").read_text())
        config["evaluators"] = [{"id": "keyless-fixture", "kind": "fixture", "endpoint": "https://fixture.invalid/", "model": "fixture-v1", "credentialRef": ""}]
        config["plugins"] = ["tests.review_fixture"]
        files["review.json"] = json.dumps(config)
    manager.run(["volume", "create", volume])
    seed = "import json,pathlib,sys; r=pathlib.Path('/config'); [(r.joinpath(k).write_text(v),r.joinpath(k).chmod(0o444)) for k,v in json.load(sys.stdin).items()]"
    manager.run(["run", "--rm", "-i", "--network", "none", "--cap-drop", "ALL", "--mount", f"type=volume,source={volume},target=/config", "--entrypoint", "python3", gateway_image, "-c", seed], data=json.dumps(files))
    environment = {"HOME": "/home/course", "DSH_HOME": "/home/course/.dsh", "DSH_TELEMETRY_MODE": "DISABLED", "NARB_NATIVE_CACHE_DIR": "/home/course/.cache/dsh-native",
        **{name: "http://127.0.0.1:3128" for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")},
        "NO_PROXY": "", "no_proxy": "", "NODE_EXTRA_CA_CERTS": "/run/course-public/ca.crt", "SSL_CERT_FILE": "/run/course-public/combined.pem",
        "REQUESTS_CA_BUNDLE": "/run/course-public/combined.pem", "CURL_CA_BUNDLE": "/run/course-public/combined.pem"}
    value = {"services": {
        "gateway": {"image": gateway_image, "cap_drop": ["ALL"], "cap_add": ["NET_ADMIN", "NET_BIND_SERVICE"], "security_opt": ["no-new-privileges:true"], "read_only": True,
            "command": ["--policy", "/etc/course/config/scope.json", "--fixtures"] + (["--review-config", "/etc/course/config/review.json"] if review else []),
            "volumes": [f"{volume}:/etc/course/config:ro", "public:/run/course-public", "review-audit:/var/lib/course-review"],
            "tmpfs": ["/run/course-private:mode=0700", "/tmp"],
            "healthcheck": {"test": ["CMD", "python3", "/opt/course/gateway.py", "--health"], "interval": "2s", "timeout": "2s", "retries": 30}},
        "research": {"image": research_image, "user": "1000:1000", "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "network_mode": "service:gateway", "read_only": True,
            "depends_on": {"gateway": {"condition": "service_healthy"}}, "shm_size": "1gb", "environment": environment,
            "volumes": ["public:/run/course-public:ro", "home:/home/course", "workspace:/workspace"], "tmpfs": ["/tmp:mode=1777"], "command": ["sleep", "infinity"]}},
        "volumes": {"public": {}, "home": {}, "workspace": {}, "review-audit": {}, volume: {"external": True}}}
    atomic(manager.compose_file, value)
    return manager, volume
