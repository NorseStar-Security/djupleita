import ipaddress
import json
from pathlib import Path
import socket
import struct
import unittest
from unittest.mock import patch

from firewall import ruleset
from packet_log import destination_packet
from policy import Policy, ScopeDenied, destination, hostname, matches


class PolicyTests(unittest.TestCase):
    def test_default_passive_sources_have_only_operational_get_access(self):
        policy = Policy(json.loads((Path(__file__).resolve().parents[1] / "scope.json").read_text()))
        for url in ("https://crt.sh/?q=%25.example.test&output=json", "http://web.archive.org/cdx/search/cdx?url=*.example.test/*&output=txt"):
            with self.subTest(url=url):
                target = destination(url)
                policy.authorize(target, "GET")
                self.assertFalse(matches(target.host, policy.domains))
                with self.assertRaises(ScopeDenied):
                    policy.authorize(target, "POST")
        for url in ("https://crt.sh/admin", "http://web.archive.org/", "https://other.crt.sh/", "https://example.org/"):
            with self.subTest(url=url), self.assertRaises(ScopeDenied):
                policy.authorize(destination(url), "GET")
        self.assertFalse(policy.ip_allowed("8.8.8.8"))

    def setUp(self):
        self.policy = Policy({"domains": ["acme.test", "*.lab.test"], "ips": ["192.0.2.0/24", "2001:db8::/32"], "exclude_domains": ["blocked.lab.test"], "exclude_ips": ["192.0.2.8", "2001:db8::8"]})

    def test_hostname_identity(self):
        for name, expected in [("ACME.com.", "acme.test"), ("bücher.test", "xn--bcher-kva.test"), ("::ffff:192.0.2.1", "192.0.2.1")]:
            with self.subTest(name=name):
                self.assertEqual(hostname(name), expected)
        for name in ["127.1", "0177.0.0.1", "0x7f000001", "127.000.0.1", "acme.test@widgets.test", "acme.test\\widgets.test", "fe80::1%eth0", "", " a.test", "a..test"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                hostname(name)

    def test_policy_dns_rules_require_explicit_ascii_names(self):
        for name in ["faß.test", "ς.test", "βόλος.test", "foo\u200cbar.test", "foo\u200dbar.test", "acme\u3002com"]:
            configs = [
                {"domains": [name]},
                {"domains": ["*." + name]},
                {"domains": ["acme.test"], "exclude_domains": [name]},
                {"domains": ["acme.test"], "exclude_domains": ["*." + name]},
                {"domains": ["acme.test"], "infrastructure": {name: {"methods": ["GET"], "paths": ["/"]}}},
                {"domains": ["acme.test"], "domain_addresses": {name: ["192.0.2.1"]}},
            ]
            for config in configs:
                with self.subTest(config=config), self.assertRaisesRegex(ValueError, "ASCII/Punycode"):
                    Policy(config)

    def test_explicit_punycode_rules_keep_their_ascii_identity(self):
        policy = Policy({"domains": ["xn--fa-hia.test", "xn--3xa.test", "xn--bcher-kva.test"], "exclude_domains": ["blocked.xn--fa-hia.test"], "infrastructure": {"api.xn--fa-hia.test": {"methods": ["GET"], "paths": ["/"]}}, "domain_addresses": {"xn--fa-hia.test": ["192.0.2.1"]}})
        for name in ["xn--fa-hia.test", "xn--3xa.test", "xn--bcher-kva.test"]:
            with self.subTest(name=name):
                policy.authorize(destination("https://" + name + "/"), "GET")
        for name in ["fass.test", "xn--4xa.test", "blocked.xn--fa-hia.test"]:
            with self.subTest(name=name):
                self.assertFalse(policy.host_allowed(name))
        self.assertEqual(policy.resolve("xn--fa-hia.test", 443), ("192.0.2.1",))
        policy.authorize(destination("https://api.xn--fa-hia.test/"), "GET")
        self.assertEqual(hostname("faß.test"), "fass.test")
        self.assertEqual(hostname("bücher.test"), "xn--bcher-kva.test")

    def test_domains_and_ips_are_separate_authorizations(self):
        for name in ["acme.test", "a.lab.test", "deep.a.lab.test", "192.0.2.1", "2001:db8::1", "::ffff:192.0.2.1"]:
            with self.subTest(name=name):
                self.assertTrue(self.policy.host_allowed(name))
        for name in ["widgets.test", "acme.test.widgets.test", "sub.acme.test", "lab.test", "blocked.lab.test", "192.0.2.8", "192.0.3.1", "2001:db8::8", "2001:db9::1", "::ffff:192.0.2.8"]:
            with self.subTest(name=name):
                self.assertFalse(self.policy.host_allowed(name))

    def test_ambiguous_urls_are_denied(self):
        for value in ["https://acme.test@widgets.test", "https://acme.test\\@widgets.test", "file:///etc/passwd", "https://acme.test:0/", "https://acme.test:65536/", "https://acme.test/#x", "https://acme.test\n"]:
            with self.subTest(value=value), self.assertRaises(ScopeDenied):
                destination(value)

    def test_infrastructure_permissions_are_not_target_scope(self):
        policy = Policy({"domains": ["acme.test"], "infrastructure": {"api.test": {"methods": ["POST"], "paths": ["/v1/infer"]}}})
        policy.authorize(destination("https://api.test/v1/infer"), "POST")
        for url, method in [("https://api.test/admin", "POST"), ("https://api.test/v1/infer", "DELETE"), ("https://api.test/v1/infer/extra", "POST")]:
            with self.subTest(url=url), self.assertRaises(ScopeDenied):
                policy.authorize(destination(url), method)
        with self.assertRaises(ScopeDenied):
            policy.authorize(destination("https://widgets.test/"), "GET")

    def test_dns_validation_does_not_open_raw_ips(self):
        answer = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        with patch("socket.getaddrinfo", return_value=answer) as resolve:
            self.assertEqual(self.policy.resolve("acme.test", 443), ("8.8.8.8",))
            resolve.assert_called_once()
        self.assertFalse(self.policy.ip_allowed("8.8.8.8"))
        for address in ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "fd00::1", "192.0.2.8"]:
            answer = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]
            with self.subTest(address=address), patch("socket.getaddrinfo", return_value=answer), self.assertRaises(ScopeDenied):
                self.policy.resolve("acme.test", 443)

    def test_domain_pins_authorize_only_proxy_connections(self):
        policy = Policy({"domains": ["acme.test"], "domain_addresses": {"acme.test": ["10.0.0.1"]}})
        self.assertEqual(policy.resolve("acme.test", 443), ("10.0.0.1",))
        self.assertFalse(policy.ip_allowed("10.0.0.1"))
        with self.assertRaises(ScopeDenied):
            policy.resolve("widgets.test", 443)

    def test_invalid_policy_fails_at_startup(self):
        for config in [{}, {"domains": ["192.0.2.1"]}, {"ips": ["192.0.2.1/24"]}, {"domains": ["acme.test"], "unexpected": True}, {"domains": ["acme.test"], "ports": {"http": [0], "https": [443]}}, {"domains": ["acme.test"], "domain_addresses": []}, {"domains": ["acme.test"], "infrastructure": {"*.api.test": {"methods": ["POST"], "paths": ["/"]}}}, {"domains": ["acme.test"], "infrastructure": {"api.test": {"methods": "POST", "paths": ["/"]}}}]:
            with self.subTest(config=config), self.assertRaises(ValueError):
                Policy(config)

    def test_mapped_addresses_cannot_bypass_exclusions(self):
        policy = Policy({"domains": ["acme.test"], "exclude_ips": ["192.0.2.8"], "domain_addresses": {"acme.test": ["::ffff:192.0.2.8"]}})
        with self.assertRaises(ScopeDenied):
            policy.resolve("acme.test", 443)

    def test_kernel_rules_never_use_dns_answers(self):
        rules = ruleset(self.policy)
        self.assertIn("meta skuid != 1000 accept", rules)
        self.assertIn("ip daddr 127.0.0.11 counter log group 100 snaplen 128 drop", rules)
        self.assertLess(rules.index("ip daddr 192.0.2.8/32"), rules.index("ip daddr 192.0.2.0/24"))
        self.assertIn("ip6 daddr 2001:db8::/32 counter accept", rules)
        self.assertIn("counter log group 100 snaplen 128 drop", rules)
        self.assertNotIn("acme", rules)

    def test_packet_log_omits_payload(self):
        ipv4 = bytearray(24)
        ipv4[0], ipv4[9] = 0x45, 6
        ipv4[16:20] = ipaddress.ip_address("192.0.2.8").packed
        struct.pack_into("!H", ipv4, 22, 443)
        self.assertEqual(destination_packet(ipv4), {"ip": "192.0.2.8", "protocol": 6, "port": 443})
        ipv6 = bytearray(44)
        ipv6[0], ipv6[6] = 0x60, 17
        ipv6[24:40] = ipaddress.ip_address("2001:db8::8").packed
        struct.pack_into("!H", ipv6, 42, 53)
        self.assertEqual(destination_packet(ipv6), {"ip": "2001:db8::8", "protocol": 17, "port": 53})
        self.assertEqual(destination_packet(b""), {})


if __name__ == "__main__":
    unittest.main()
