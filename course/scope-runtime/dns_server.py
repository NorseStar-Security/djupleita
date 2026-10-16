"""A scope-aware resolver for tool programs; the gateway uses its trusted resolver."""

import ipaddress
from dnslib import A, AAAA, DNSRecord, QTYPE, RCODE, RR
from dnslib.server import BaseResolver, DNSLogger, DNSServer
from policy import ScopeDenied, hostname


class Resolver(BaseResolver):
    def __init__(self, policy, audit, upstream):
        self.policy, self.audit, self.upstream = policy, audit, upstream

    def resolve(self, request, handler):
        reply = request.reply()
        try:
            if len(request.questions) != 1:
                raise ScopeDenied("exactly one DNS question is required")
            name = hostname(str(request.q.qname))
            if not self.policy.host_allowed(name):
                raise ScopeDenied("DNS name is outside scope")
            if name in self.policy.pins:
                for address in self.policy.resolve(name, 443):
                    ip = ipaddress.ip_address(address)
                    kind = QTYPE.A if ip.version == 4 else QTYPE.AAAA
                    if request.q.qtype in (kind, QTYPE.ANY):
                        reply.add_answer(RR(request.q.qname, kind, ttl=30, rdata=A(address) if ip.version == 4 else AAAA(address)))
                return reply
            response = DNSRecord.parse(request.send(self.upstream, 53, tcp=handler.protocol == "tcp", timeout=5))
            for record in response.rr + response.auth + response.ar:
                if record.rtype in (QTYPE.A, QTYPE.AAAA):
                    address = ipaddress.ip_address(str(record.rdata))
                    if self.policy.ip_excluded(address) or (not address.is_global and not self.policy.ip_allowed(address)):
                        raise ScopeDenied("DNS answer requires explicit lab authorization")
            return response
        except (ScopeDenied, ValueError, OSError) as error:
            self.audit("denied", transport="dns", reason=str(error), host=str(request.q.qname))
            reply.header.rcode = RCODE.REFUSED
            return reply


def start(policy, audit, upstream):
    resolver = Resolver(policy, audit, upstream)
    servers = [DNSServer(resolver, address="127.0.0.1", port=53, tcp=tcp, logger=DNSLogger("-request,-reply,-truncated,-error")) for tcp in (False, True)]
    for server in servers:
        server.start_thread()
    return servers
