"""Offline checks for checksum verification and restricted recon archive extraction."""
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from install_recon import install


class ReconInstallerTests(unittest.TestCase):
    def archive(self):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as bundle:
            bundle.writestr("subfinder", b"fixture executable")
            bundle.writestr("LICENSE.md", b"fixture license")
            bundle.writestr("../../NOTICE", b"fixture notice")
            bundle.writestr("../../outside", b"must not be extracted")
            bundle.writestr("extra-executable", b"must not be extracted")
        return payload.getvalue()

    def test_installs_only_named_binary_and_flattened_license_files(self):
        archive = self.archive()
        digest = hashlib.sha256(archive).hexdigest()
        for architecture in ("amd64", "arm64"):
            with self.subTest(architecture=architecture), tempfile.TemporaryDirectory() as root:
                destination = Path(root) / "bin"
                manifest = {"subfinder": {"version": "1.2.3", "sha256": {architecture: digest}}}
                with patch("install_recon.urllib.request.urlopen", return_value=io.BytesIO(archive)) as download:
                    install(architecture, destination, manifest)
                download.assert_called_once_with(
                    f"https://github.com/projectdiscovery/subfinder/releases/download/v1.2.3/subfinder_1.2.3_linux_{architecture}.zip",
                    timeout=120,
                )
                self.assertEqual((destination / "subfinder").read_bytes(), b"fixture executable")
                self.assertEqual((destination / "subfinder").stat().st_mode & 0o777, 0o755)
                self.assertEqual((Path(root) / "licenses/subfinder/LICENSE.md").read_bytes(), b"fixture license")
                self.assertEqual((Path(root) / "licenses/subfinder/NOTICE").read_bytes(), b"fixture notice")
                self.assertEqual(
                    {str(path.relative_to(root)) for path in Path(root).rglob("*") if path.is_file()},
                    {"bin/subfinder", "licenses/subfinder/LICENSE.md", "licenses/subfinder/NOTICE"},
                )

    def test_checksum_mismatch_does_not_install_an_executable(self):
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / "bin"
            manifest = {"subfinder": {"version": "1.2.3", "sha256": {"amd64": "0" * 64}}}
            with patch("install_recon.urllib.request.urlopen", return_value=io.BytesIO(self.archive())), self.assertRaisesRegex(ValueError, "checksum mismatch"):
                install("amd64", destination, manifest)
            self.assertEqual(list(destination.iterdir()), [])

    def test_rejects_unsupported_architecture_before_downloading_or_creating_paths(self):
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / "bin"
            with patch("install_recon.urllib.request.urlopen") as download, self.assertRaisesRegex(ValueError, "amd64 and arm64"):
                install("mips", destination, {})
            download.assert_not_called()
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
