"""Operation rules and shared request budgets below every HTTP-capable tool."""

from collections import deque
import re
import threading
import time
from urllib.parse import unquote_to_bytes


def canonical_method(value):
    """Accept HTTP method tokens and match deny rules independently of casing."""
    if not isinstance(value, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", value):
        raise ValueError("invalid HTTP method")
    return value.upper()


def canonical_path(value):
    """Decode the path once; reject ambiguous separators, dot segments and encodings."""
    path = value.split("?", 1)[0]
    if re.search(r"%(?![0-9a-fA-F]{2})", path) or re.search(r"%(?:2f|5c|25|3f|23|00)", path, re.I):
        raise ValueError("ambiguous encoded path")
    path = unquote_to_bytes(path).decode("utf-8", "strict")
    if not path.startswith("/") or "//" in path or re.search(r"[\\;\s\x00-\x1f\x7f]", path):
        raise ValueError("ambiguous path")
    if any(part in (".", "..") for part in path.split("/")):
        raise ValueError("ambiguous dot segment")
    return path.rstrip("/") or "/"


class OperationPolicy:
    """Match method/path denials; required mediation rejects every raw-IP grant.

    Prefixes cover a path and its descendants, not arbitrary character prefixes.
    Query parameters, body semantics and WebSocket messages are not inspected.
    """

    def __init__(self, config, has_raw_ips):
        if not isinstance(config, dict) or set(config) != {"deny", "requireMediatedHttp", "budget"}:
            raise ValueError("operations requires deny, requireMediatedHttp and budget")
        if type(config["requireMediatedHttp"]) is not bool or config["requireMediatedHttp"] and has_raw_ips:
            raise ValueError("operation enforcement requires mediated HTTP; remove raw IP grants")
        rules = config["deny"]
        if not isinstance(rules, list):
            raise ValueError("operations.deny must be an array")
        parsed, ids = [], set()
        for rule in rules:
            if not isinstance(rule, dict) or set(rule) != {"id", "methods", "paths", "prefixes"}:
                raise ValueError("operation rules require id, methods, paths and prefixes")
            if not isinstance(rule["id"], str) or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,80}", rule["id"]) or rule["id"] in ids:
                raise ValueError("operation rule ids must be unique")
            ids.add(rule["id"])
            if not isinstance(rule["methods"], list) or not rule["methods"] or not all(isinstance(v, str) and canonical_method(v) == v for v in rule["methods"]):
                raise ValueError("invalid operation methods")
            for key in ("paths", "prefixes"):
                if not isinstance(rule[key], list) or not all(isinstance(v, str) and "?" not in v and "#" not in v and canonical_path(v) == v for v in rule[key]):
                    raise ValueError("operation paths must be canonical")
            if not rule["paths"] and not rule["prefixes"]:
                raise ValueError("an operation rule needs paths or prefixes")
            parsed.append((rule["id"], frozenset(rule["methods"]), frozenset(rule["paths"]), tuple(rule["prefixes"])))
        self.rules = tuple(parsed)
        budget = config["budget"]
        if not isinstance(budget, dict) or set(budget) != {"maxRequests", "windowSeconds", "maxConcurrent"}:
            raise ValueError("invalid operation budget")
        if not all(type(budget[k]) is int and 1 <= budget[k] <= 1_000_000 for k in budget):
            raise ValueError("operation budgets must be positive bounded integers")
        self.budget = dict(budget)

    def authorize(self, path, method):
        path = canonical_path(path)
        method = canonical_method(method)
        for identity, methods, paths, prefixes in self.rules:
            if ("*" in methods or method in methods) and (path in paths or any(prefix == "/" or path == prefix or path.startswith(prefix + "/") for prefix in prefixes)):
                raise ValueError("operation denied by rule " + identity)


class RequestBudget:
    """Atomically limit admitted requests across threads, hosts and HTTP/TLS.

    An admitted failure still consumes its rolling-window rate allowance. Active
    admission lasts through body reads, responses and an upgraded WebSocket's
    lifetime; its individual messages do not consume new request admissions.
    """

    def __init__(self, config, clock=time.monotonic):
        self.config, self.clock = dict(config), clock
        self.starts, self.active = deque(), 0
        self.lock = threading.Lock()

    def acquire(self):
        with self.lock:
            now = self.clock()
            while self.starts and self.starts[0] <= now - self.config["windowSeconds"]:
                self.starts.popleft()
            if len(self.starts) >= self.config["maxRequests"] or self.active >= self.config["maxConcurrent"]:
                raise ValueError("course request budget exhausted")
            self.starts.append(now)
            self.active += 1

    def release(self):
        with self.lock:
            if self.active == 0:
                raise ValueError("request budget release without admission")
            self.active -= 1
