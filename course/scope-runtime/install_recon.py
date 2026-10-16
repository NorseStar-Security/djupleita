"""Build-time installation of checksum-pinned ProjectDiscovery Linux executables."""
import hashlib
import io
import json
from pathlib import Path
import sys
import urllib.request
import zipfile


def install(architecture, destination, manifest):
    """Install only named executables and license files from verified release archives."""
    if architecture not in {"amd64", "arm64"}:
        raise ValueError("Recon binaries support Linux amd64 and arm64 only")
    destination.mkdir(parents=True, exist_ok=True)
    for name, release in manifest.items():
        version = release["version"]
        url = f"https://github.com/projectdiscovery/{name}/releases/download/v{version}/{name}_{version}_linux_{architecture}.zip"
        with urllib.request.urlopen(url, timeout=120) as response:
            archive = response.read(256 * 1024 * 1024 + 1)
        if len(archive) > 256 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != release["sha256"][architecture]:
            raise ValueError(f"Release checksum mismatch: {name}")
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            binary = destination / name
            binary.write_bytes(bundle.read(name))
            binary.chmod(0o755)
            license_path = destination.parent / "licenses" / name
            license_path.mkdir(parents=True, exist_ok=True)
            for member in bundle.namelist():
                if Path(member).name.upper().startswith(("LICENSE", "NOTICE")):
                    (license_path / Path(member).name).write_bytes(bundle.read(member))


if __name__ == "__main__":
    install(sys.argv[1], Path(sys.argv[2]), json.loads(Path(sys.argv[3]).read_text()))
