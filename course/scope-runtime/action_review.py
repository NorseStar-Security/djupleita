"""Fail-closed admission and durable receipts outside the untrusted research container."""

from datetime import datetime, timezone
from contextlib import contextmanager
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from urllib.parse import urlsplit

import review_providers


class ReviewUnavailable(RuntimeError):
    """No receipt means no permission; caller must not dispatch the tool."""


class Registry:
    """Trusted deployment plugins register evaluators without changing admission policy."""

    def __init__(self):
        self.providers = {}

    def add(self, kind, provider):
        if not re.fullmatch(r"[a-z][a-z0-9_-]*", kind) or kind in self.providers or not callable(provider):
            raise ValueError("invalid or duplicate review provider")
        self.providers[kind] = provider


def configuration(value, *, complete=False):
    """Validate staged settings; incomplete drafts save, but cannot be applied."""
    if not isinstance(value, dict) or set(value) != {"policyVersion", "rulesOfEngagement", "rubrics", "evaluators", "plugins", "timeoutSeconds", "archiveLeaseSeconds", "startupGraceSeconds", "maxInputBytes", "maxResponseBytes", "maxAuditBytes"}:
        raise ValueError("Invalid action review configuration; load the course review defaults")
    for field in ("policyVersion", "rulesOfEngagement"):
        if not isinstance(value[field], str) or not value[field].strip() or len(value[field]) > 32768:
            raise ValueError("Action review needs a policy version and trusted rules of engagement")
    for field, lower, upper in (("timeoutSeconds", 1, 120), ("archiveLeaseSeconds", 5, 300), ("startupGraceSeconds", 5, 600), ("maxInputBytes", 1024, 1048576), ("maxResponseBytes", 1024, 1048576), ("maxAuditBytes", 1048576, 10737418240)):
        if type(value[field]) is not int or not lower <= value[field] <= upper:
            raise ValueError("Invalid action review limit: " + field)
    rubrics = value["rubrics"]
    if not isinstance(rubrics, list) or not 1 <= len(rubrics) <= 32:
        raise ValueError("Action review needs risk rubrics")
    identifiers = set()
    for row in rubrics:
        if not isinstance(row, dict) or set(row) != {"id", "instructions", "maxProbability"} or not isinstance(row["id"], str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", row["id"]) or row["id"] in identifiers:
            raise ValueError("Invalid or duplicate risk rubric")
        identifiers.add(row["id"])
        if not isinstance(row["instructions"], str) or not row["instructions"].strip() or len(row["instructions"]) > 8192 or type(row["maxProbability"]) not in (float, int) or not 0 < row["maxProbability"] <= 1:
            raise ValueError("Invalid rubric instructions or threshold")
    if not {"destructive", "insufficient_context"} <= identifiers:
        raise ValueError("Destructive and insufficient_context rubrics are mandatory")
    evaluators = value["evaluators"]
    if not isinstance(evaluators, list) or not 1 <= len(evaluators) <= 8:
        raise ValueError("At least one action evaluator is mandatory")
    identifiers = set()
    for row in evaluators:
        if not isinstance(row, dict) or not {"id", "kind", "endpoint", "model", "credentialRef"} <= set(row) or set(row) - {"id", "kind", "endpoint", "model", "credentialRef", "options"} or ("options" in row and not isinstance(row["options"], dict)):
            raise ValueError("Invalid evaluator configuration")
        if any(not isinstance(row[field], str) for field in ("id", "kind", "endpoint", "model", "credentialRef")) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", row["id"]) or row["id"] in identifiers or not re.fullmatch(r"[a-z][a-z0-9_-]*", row["kind"]):
            raise ValueError("Invalid evaluator identity")
        identifiers.add(row["id"])
        url = urlsplit(row["endpoint"])
        if url.scheme != "https" or not url.hostname or url.username is not None or url.password is not None or url.query or url.fragment:
            raise ValueError("Evaluator endpoint must be HTTPS without embedded credentials or query")
        try:
            url.port
        except ValueError as error:
            raise ValueError("Invalid evaluator endpoint port") from error
        if len(row["model"]) > 256 or len(row["credentialRef"]) > 256 or not re.fullmatch(r"[A-Za-z0-9_.:/-]*", row["credentialRef"]):
            raise ValueError("Invalid evaluator model or credential reference")
        if complete and not row["model"].strip():
            raise ValueError("Choose an explicit model for every action evaluator before applying")
    if not isinstance(value["plugins"], list) or len(value["plugins"]) > 16 or any(not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*", name) for name in value["plugins"]):
        raise ValueError("Invalid instructor review plugin modules")
    return value


def digest(config, policy_hash):
    return hashlib.sha256(json.dumps({"config": config, "policyHash": policy_hash}, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class Engine:
    def __init__(self, config, policy, instance, credentials, database, *, network_policy=None, registry=None, transport=review_providers.post_json, archive_lease=None):
        self.config = configuration(config, complete=True)
        self.policy, self.instance = policy, instance
        self.network_policy = network_policy if network_policy is not None else {}
        self.archive_lease = Path(archive_lease) if archive_lease else None
        self.startup_deadline = time.monotonic() + config["startupGraceSeconds"]
        self.review_hash = digest(config, policy.digest)
        self.registry = registry or Registry()
        if registry is None:
            review_providers.register(self.registry)
            # These module names originate only in the instructor's immutable deployment.
            for module in config["plugins"]:
                importlib.import_module(module).register(self.registry)
        self.credentials, self.transport = credentials, transport
        for evaluator in config["evaluators"]:
            if evaluator["kind"] not in self.registry.providers:
                raise ValueError("Action evaluator plugin is unavailable: " + evaluator["kind"])
            reference = evaluator["credentialRef"]
            if reference and (not isinstance(credentials.get(reference), str) or not credentials[reference]):
                raise ValueError("Action evaluator credential is missing: " + reference)
        self.database = Path(database)
        self.database.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.lock = threading.Lock()
        self.failed = False
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE IF NOT EXISTS decisions (receipt INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, instance TEXT NOT NULL, policy_hash TEXT NOT NULL, review_hash TEXT NOT NULL, input_hash TEXT NOT NULL, decision TEXT NOT NULL, code TEXT NOT NULL, findings TEXT NOT NULL, action TEXT NOT NULL)")
        os.chmod(self.database, 0o600)

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.database, timeout=5)
        try:
            connection.execute("PRAGMA synchronous=FULL")
            with connection:
                yield connection
        finally:
            connection.close()

    def audit_ready(self, reserve=0):
        size = sum(path.stat().st_size for path in (self.database, Path(str(self.database) + "-wal"), Path(str(self.database) + "-shm")) if path.exists())
        return not self.failed and size + reserve < self.config["maxAuditBytes"]

    def lease_ready(self):
        if self.archive_lease is None:
            return True
        try:
            until = float(self.archive_lease.read_text())
            return math.isfinite(until) and time.monotonic() < until <= time.monotonic() + self.config["archiveLeaseSeconds"] + 1
        except (ValueError, OSError):
            return False

    def healthy(self):
        # Startup grace permits starting the worker so native intake can first observe it.
        # Admission itself never receives this grace.
        return self.audit_ready() and (self.lease_ready() or time.monotonic() < self.startup_deadline)

    def status(self):
        return {"protocol": 1, "instance": self.instance, "policyHash": self.policy.digest,
                "reviewHash": self.review_hash, "ready": self.audit_ready() and self.lease_ready()}

    def redact(self, value):
        """Strip configured keys and credential fields; no claim to detect arbitrary secrets."""
        if isinstance(value, str):
            for secret in self.credentials.values():
                if secret:
                    value = value.replace(secret, "[REDACTED]")
            return value
        if isinstance(value, list):
            return [self.redact(item) for item in value]
        if isinstance(value, dict):
            return {name: "[REDACTED]" if re.search(r"(?i)(password|secret|authorization|api.?key|access.?token)", name) else self.redact(item) for name, item in value.items()}
        return value

    def review(self, raw):
        if not self.status()["ready"]:
            raise ReviewUnavailable("Action review audit is unavailable")
        if len(raw) > self.config["maxInputBytes"]:
            raise ValueError("Action review request is too large")
        value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))
        if not isinstance(value, dict) or set(value) != {"action", "policyHash"} or not isinstance(value["action"], dict):
            raise ValueError("Invalid action review request")
        action = value["action"]
        required = {"callId", "rootCallId", "sessionId", "tool", "arguments"}
        if not required <= set(action) or set(action) - required - {"parentCallId", "schema"}:
            raise ValueError("Invalid action context")
        for field in ("callId", "rootCallId", "tool", "parentCallId"):
            if field in action and (not isinstance(action[field], str) or not action[field] or len(action[field]) > 1024):
                raise ValueError("Invalid action identity")
        if action["sessionId"] is not None and (not isinstance(action["sessionId"], str) or not action["sessionId"] or len(action["sessionId"]) > 1024):
            raise ValueError("Invalid action session")
        safe_action = self.redact(action)
        saved_action = json.dumps(safe_action, ensure_ascii=False, allow_nan=False)
        input_hash = hashlib.sha256(raw).hexdigest()
        # A crash during an external evaluator call leaves a durable deny/pending row,
        # never a missing request or an implied execution authorization.
        try:
            with self.lock:
                if not self.status()["ready"]:
                    raise ReviewUnavailable("Action review audit is unavailable")
                if not self.audit_ready(4 * len(saved_action.encode()) + 65536):
                    raise ReviewUnavailable("Action review audit capacity is exhausted")
                with self.connect() as connection:
                    receipt = connection.execute("INSERT INTO decisions(time,instance,policy_hash,review_hash,input_hash,decision,code,findings,action) VALUES(?,?,?,?,?,?,?,?,?)", (
                        datetime.now(timezone.utc).isoformat(), self.instance, self.policy.digest, self.review_hash, input_hash,
                        "deny", "ACTION_REVIEW_PENDING", "[]", saved_action)).lastrowid
        except (OSError, sqlite3.Error, ReviewUnavailable) as error:
            self.failed = True
            raise ReviewUnavailable("Action review request commit failed") from error
        findings, decision, code = [], "deny", "ACTION_CONTEXT_REQUIRED"
        if value["policyHash"] != self.policy.digest:
            code = "ACTION_POLICY_CHANGED"
        elif safe_action != action:
            code = "ACTION_REDACTED_CONTEXT"
        elif action["sessionId"] is not None and isinstance(action.get("schema"), dict):
            deadline = time.monotonic() + self.config["timeoutSeconds"]
            code = "ACTION_REVIEW_FAILED"
            try:
                state = {"rulesOfEngagement": self.config["rulesOfEngagement"], "networkPolicy": self.network_policy,
                         "action": safe_action}
                for evaluator in self.config["evaluators"]:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("review deadline exceeded")
                    model, risks = self.registry.providers[evaluator["kind"]](evaluator, state, self.config["rubrics"],
                        self.credentials.get(evaluator["credentialRef"], ""), deadline, self.config["maxResponseBytes"], self.transport)
                    if not isinstance(model, str) or not model or len(model) > 256 or self.redact(model) != model or not isinstance(risks, dict) or set(risks) != {row["id"] for row in self.config["rubrics"]} or any(type(score) not in (float, int) or not math.isfinite(score) or not 0 <= score <= 1 for score in risks.values()):
                        raise ValueError("Invalid action assessment")
                    findings.append({"evaluator": evaluator["id"], "model": model, "risks": risks})
                if time.monotonic() >= deadline:
                    raise TimeoutError("review deadline exceeded")
                risky = any(row["risks"][rubric["id"]] >= rubric["maxProbability"] for row in findings for rubric in self.config["rubrics"])
                decision, code = ("deny", "ACTION_RISK_DENIED") if risky else ("allow", "ACTION_REVIEW_ALLOWED")
            except Exception:
                # Remote response text and exception details can contain credentials or prompts.
                decision, code = "deny", "ACTION_REVIEW_FAILED"
        if not self.lease_ready():
            decision, code = "deny", "ACTION_ARCHIVE_UNAVAILABLE"
        try:
            with self.lock:
                if not self.audit_ready(4 * len(json.dumps(findings).encode()) + 65536):
                    raise ReviewUnavailable("Action review audit is unavailable")
                with self.connect() as connection:
                    changed = connection.execute("UPDATE decisions SET decision=?,code=?,findings=? WHERE receipt=? AND instance=?", (
                        decision, code, json.dumps(findings, allow_nan=False), receipt, self.instance)).rowcount
                    if changed != 1:
                        raise ReviewUnavailable("Action review request receipt disappeared")
                # Context manager commits synchronously before an allow can be acknowledged.
        except (OSError, sqlite3.Error, ReviewUnavailable) as error:
            self.failed = True
            raise ReviewUnavailable("Action review audit commit failed") from error
        return {"protocol": 1, "instance": self.instance, "policyHash": self.policy.digest,
                "reviewHash": self.review_hash, "inputHash": input_hash, "decision": decision,
                "code": code, "findings": findings, "receipt": receipt}
