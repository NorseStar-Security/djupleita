"""An ephemeral course CA; only its public certificates enter the research container."""

from collections import OrderedDict
from pathlib import Path
import secrets
import ssl
import subprocess
import threading


class Certificates:
    def __init__(self, private, public):
        self.private, self.public = Path(private), Path(public)
        self.private.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.public.mkdir(mode=0o755, parents=True, exist_ok=True)
        self.key = self.private / "ca.key"
        self.ca = self.public / "ca.crt"
        self.leaf_key = self.private / "leaf.key"
        self.contexts = OrderedDict()
        self.lock = threading.Lock()
        if not self.key.exists() or not self.ca.exists():
            self.run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "7", "-subj", "/CN=DSH isolated course CA", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", str(self.key), "-out", str(self.ca)])
        if not self.leaf_key.exists():
            self.run(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(self.leaf_key)])
        self.key.chmod(0o600)
        self.leaf_key.chmod(0o600)
        self.ca.chmod(0o644)
        cafile = ssl.get_default_verify_paths().cafile
        roots = Path(cafile).read_bytes() if cafile else b"".join(
            ssl.DER_cert_to_PEM_cert(cert).encode() for cert in ssl.create_default_context().get_ca_certs(binary_form=True)
        )
        (self.public / "combined.pem").write_bytes(roots + b"\n" + self.ca.read_bytes())
        (self.public / "combined.pem").chmod(0o644)

    @staticmethod
    def run(args, data=None):
        return subprocess.run(["openssl", *args], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=15).stdout

    def context(self, host):
        """Create a bounded certificate cache; callers supply normalized hostnames."""
        with self.lock:
            if host in self.contexts:
                self.contexts.move_to_end(host)
                return self.contexts[host]
            import ipaddress
            try:
                ipaddress.ip_address(host)
                kind = "IP"
            except ValueError:
                kind = "DNS"
            request = self.run(["req", "-new", "-key", str(self.leaf_key), "-subj", f"/CN={host[:63]}", "-addext", f"subjectAltName={kind}:{host}"])
            cert = self.private / "leaf.crt"
            self.run(["x509", "-req", "-CA", str(self.ca), "-CAkey", str(self.key), "-set_serial", "0x" + secrets.token_hex(16), "-copy_extensions", "copy", "-days", "2", "-out", str(cert)], request)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.set_alpn_protocols(["http/1.1"])
            context.load_cert_chain(cert, self.leaf_key)
            cert.unlink()
            self.contexts[host] = context
            if len(self.contexts) > 256:
                self.contexts.popitem(last=False)
            return context
