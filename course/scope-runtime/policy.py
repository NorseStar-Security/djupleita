"""Instructor-owned destination policy; DNS answers never grant raw IP access."""

from dataclasses import dataclass
import hashlib
import ipaddress
import json
import re
import socket
from urllib.parse import urlsplit
from operations import OperationPolicy, canonical_method, canonical_path


class ScopeDenied(Exception):
    """A destination or operation is outside the configured policy."""


def hostname(value):
    """Canonicalize a DNS name or an unambiguous IP literal, without URL syntax."""
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError("invalid hostname")
    value = value.removesuffix(".")
    try:
        address = ipaddress.ip_address(value)
        if "%" in value:
            raise ValueError("IPv6 zone identifiers are not supported")
        return str(address.ipv4_mapped if address.version == 6 and address.ipv4_mapped else address)
    except ValueError:
        if any(char in value for char in "/\\:@%[]?#"):
            raise ValueError("invalid hostname") from None
    value = value.encode("idna").decode("ascii").lower()
    if len(value) > 253 or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in value.split(".")):
        raise ValueError("invalid DNS name")
    if re.fullmatch(r"[0-9.]+", value) or value.startswith("0x"):
        raise ValueError("legacy numeric IP spellings are not supported")
    return value


def domain_rule(value):
    """Parse an ASCII DNS rule or descendant-only wildcard without IDNA aliasing."""
    if isinstance(value, str) and not value.isascii():
        raise ValueError("policy DNS rules require explicit ASCII/Punycode names")
    wildcard = isinstance(value, str) and value.startswith("*.")
    name = hostname(value[2:] if wildcard else value)
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return name, wildcard
    raise ValueError("use ips, not domains, for IP scope")


def matches(name, rules):
    return any(name.endswith("." + domain) if wildcard else name == domain for domain, wildcard in rules)


def networks(values):
    """Require canonical network addresses; reject accidentally widened CIDRs."""
    result = []
    for value in values:
        network = ipaddress.ip_network(value, strict=True)
        if network.version == 6 and network.network_address.ipv4_mapped:
            raise ValueError("use IPv4 rules instead of IPv4-mapped IPv6 networks")
        result.append(network)
    return tuple(result)


@dataclass(frozen=True)
class Destination:
    scheme: str
    host: str
    port: int
    path: str

    @property
    def authority(self):
        name = f"[{self.host}]" if ":" in self.host else self.host
        return f"{name}:{self.port}"


def destination(url):
    """Parse an HTTP(S) URL without credentials, whitespace, or parser ambiguity."""
    if not isinstance(url, str) or re.search(r"[\s\\\x00-\x1f\x7f]", url):
        raise ScopeDenied("ambiguous URL")
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or parsed.username is not None or parsed.password is not None or parsed.fragment:
            raise ValueError("unsupported URL")
        host = hostname(parsed.hostname)
        port = parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
        if not 1 <= port <= 65535:
            raise ValueError("invalid port")
        return Destination(parsed.scheme, host, port, (parsed.path or "/") + ("?" + parsed.query if parsed.query else ""))
    except (ValueError, TypeError, UnicodeError):
        raise ScopeDenied("invalid HTTP(S) destination") from None


class Policy:
    """Immutable-at-startup policy, shared by the gateway and kernel-rule compiler."""

    def __init__(self, config):
        known = {"domains", "ips", "exclude_domains", "exclude_ips", "domain_addresses", "infrastructure", "ports", "operations"}
        if not isinstance(config, dict) or set(config) - known:
            raise ValueError("unknown scope policy field")
        for key in ("domains", "ips", "exclude_domains", "exclude_ips"):
            if not isinstance(config.get(key, []), list):
                raise ValueError(f"{key} must be an array")
        self.domains = tuple(domain_rule(value) for value in config.get("domains", []))
        self.excluded_domains = tuple(domain_rule(value) for value in config.get("exclude_domains", []))
        self.ips = networks(config.get("ips", []))
        self.excluded_ips = networks(config.get("exclude_ips", []))
        self.operations = OperationPolicy(config["operations"], bool(self.ips)) if "operations" in config else None
        if not self.domains and not self.ips:
            raise ValueError("configure at least one target domain or IP/CIDR")
        for key in ("domain_addresses", "infrastructure", "ports"):
            if key in config and not isinstance(config[key], dict):
                raise ValueError(f"{key} must be an object")
        self.pins = {}
        for name, values in config.get("domain_addresses", {}).items():
            name, wildcard = domain_rule(name)
            if wildcard:
                raise ValueError("domain_addresses requires exact hostnames")
            if not values or not isinstance(values, list):
                raise ValueError("domain_addresses entries need explicit IP arrays")
            self.pins[name] = tuple(str(ipaddress.ip_address(value)) for value in values)
        self.infrastructure = {}
        for name, rule in config.get("infrastructure", {}).items():
            name, wildcard = domain_rule(name)
            if wildcard or not isinstance(rule, dict) or set(rule) != {"methods", "paths"} or not all(isinstance(rule[key], list) and rule[key] for key in ("methods", "paths")):
                raise ValueError("infrastructure requires methods and exact paths")
            if not all(isinstance(value, str) and value != "*" and canonical_method(value) == value for value in rule["methods"]) or not all(isinstance(value, str) and not re.search(r"[?#]", value) and canonical_path(value) == value for value in rule["paths"]):
                raise ValueError("invalid infrastructure methods or paths")
            self.infrastructure[name] = (frozenset(rule["methods"]), frozenset(rule["paths"]))
        ports = config.get("ports", {"http": [80], "https": [443]})
        if set(ports) != {"http", "https"}:
            raise ValueError("ports requires http and https lists")
        self.ports = {}
        for scheme, values in ports.items():
            if not isinstance(values, list) or not all(type(port) is int and 1 <= port <= 65535 for port in values):
                raise ValueError("invalid HTTP(S) port list")
            self.ports[scheme] = frozenset(values)
        self.digest = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def ip_allowed(self, address):
        address = ipaddress.ip_address(address)
        if address.version == 6 and address.ipv4_mapped:
            address = address.ipv4_mapped
        return not self.ip_excluded(address) and any(address.version == net.version and address in net for net in self.ips)

    def ip_excluded(self, address):
        address = ipaddress.ip_address(address)
        if address.version == 6 and address.ipv4_mapped:
            address = address.ipv4_mapped
        return any(address.version == net.version and address in net for net in self.excluded_ips)

    def host_allowed(self, name):
        name = hostname(name)
        if matches(name, self.excluded_domains):
            return False
        try:
            return self.ip_allowed(name)
        except ValueError:
            return matches(name, self.domains) or name in self.infrastructure

    def authorize(self, target, method):
        if target.port not in self.ports[target.scheme] or not self.host_allowed(target.host):
            raise ScopeDenied("destination is outside scope")
        if self.operations is not None:
            try:
                self.operations.authorize(target.path, method)
            except (ValueError, UnicodeError) as error:
                raise ScopeDenied(str(error)) from None
        if target.host in self.infrastructure:
            methods, paths = self.infrastructure[target.host]
            path = target.path.split("?", 1)[0]
            try:
                canonical_path(path)
            except (ValueError, UnicodeError):
                raise ScopeDenied("ambiguous infrastructure path") from None
            if method not in methods or path not in paths:
                raise ScopeDenied("infrastructure permission does not authorize this operation")

    def resolve(self, name, port):
        """Return validated, pinned connection addresses, never a second DNS lookup."""
        name = hostname(name)
        if not self.host_allowed(name):
            raise ScopeDenied("hostname is outside scope")
        pinned = self.pins.get(name)
        if pinned is not None:
            addresses = pinned
        else:
            addresses = tuple(dict.fromkeys(item[4][0] for item in socket.getaddrinfo(name, port, type=socket.SOCK_STREAM)))
        if not addresses:
            raise ScopeDenied("destination has no addresses")
        for value in addresses:
            address = ipaddress.ip_address(value)
            if self.ip_excluded(address) or (not address.is_global and value not in (pinned or ()) and not self.ip_allowed(address)):
                raise ScopeDenied("DNS answer is excluded or requires explicit lab authorization")
        return addresses
