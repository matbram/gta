#!/usr/bin/env python3
"""Queue model-authored ADH payloads locally and deliver them from lifecycle hooks.

Claude Code Web's auto-mode classifier correctly treats a model-issued curl POST
as possible data exfiltration.  The model-facing helpers therefore only write a
bounded envelope under the repository's private Git state.  This helper's drain
command is called by the already-configured ADH lifecycle hook, which has a
fixed destination, fixed endpoints, and a project-scoped token.
"""

from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import uuid


CONNECTOR_VERSION = 6
ENVELOPE_SCHEMA_VERSION = 1
MAX_PAYLOAD_BYTES = 128 * 1024
MAX_ENVELOPE_BYTES = 160 * 1024
MAX_OUTBOX_FILES = 64
SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$")
SAFE_REPOSITORY = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$"
)
CAPTURE_KEYS = {"continuity", "research", "suggestions", "assessment"}
RESEARCH_KEYS = {
    "topic",
    "question",
    "purpose",
    "conclusion",
    "key_findings",
    "sources",
    "implications",
    "contradictions",
    "unresolved_questions",
    "confidence",
    "freshness",
    "status",
}
ENVELOPE_KEYS = {
    "schema_version",
    "delivery_id",
    "kind",
    "repository",
    "session_id",
    "agent_id",
    "created_at",
    "payload",
}


class OutboxError(Exception):
    pass


def project_root() -> Path:
    return Path(os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())).resolve()


def git_path(root: Path, relative: str) -> Path:
    result = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--git-path", relative],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=3,
    )
    value = Path(result.stdout.strip())
    return value if value.is_absolute() else root / value


def read_bounded_json_stream() -> dict:
    raw = sys.stdin.buffer.read(MAX_PAYLOAD_BYTES + 1)
    if len(raw) > MAX_PAYLOAD_BYTES:
        raise OutboxError(f"ADH payload exceeds {MAX_PAYLOAD_BYTES} bytes")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OutboxError("ADH payload is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise OutboxError("ADH payload must be a JSON object")
    return value


def read_config(root: Path) -> dict:
    path = root / ".adh" / "config.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OutboxError("ADH repository configuration is unavailable") from error
    if not isinstance(value, dict):
        raise OutboxError("ADH repository configuration is invalid")
    repository = value.get("repository")
    if not isinstance(repository, str) or not SAFE_REPOSITORY.fullmatch(repository):
        raise OutboxError("ADH repository binding is missing or invalid")
    return value


def session_id(root: Path) -> str:
    value = os.environ.get("CLAUDE_CODE_REMOTE_SESSION_ID", "")
    if value.startswith("cse_"):
        value = value[4:]
    if not value:
        path = git_path(root, "adh/session-id")
        try:
            value = path.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise OutboxError("ADH session binding is unavailable") from error
    if not SAFE_IDENTIFIER.fullmatch(value):
        raise OutboxError("ADH session binding is invalid")
    return value


def validate_payload(kind: str, payload: dict) -> None:
    keys = set(payload)
    if kind == "session_capture":
        if not {"continuity", "research", "suggestions", "assessment"}.issubset(keys):
            raise OutboxError("ADH turn capture is missing required fields")
        if not keys.issubset(CAPTURE_KEYS):
            raise OutboxError("ADH turn capture contains unknown fields")
        if not isinstance(payload.get("continuity"), dict):
            raise OutboxError("ADH turn capture continuity must be an object")
        if not isinstance(payload.get("research"), list):
            raise OutboxError("ADH turn capture research must be an array")
        if not isinstance(payload.get("suggestions"), list):
            raise OutboxError("ADH turn capture suggestions must be an array")
        if not isinstance(payload.get("assessment"), dict):
            raise OutboxError("ADH turn capture assessment must be an object")
        return
    if kind == "research":
        if not {"topic", "question", "key_findings", "sources"}.issubset(keys):
            raise OutboxError("ADH research dossier is missing required fields")
        if not keys.issubset(RESEARCH_KEYS):
            raise OutboxError("ADH research dossier contains unknown fields")
        return
    raise OutboxError("unsupported ADH outbox kind")


def fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_envelope(root: Path, kind: str, payload: dict, agent_id: str | None) -> dict:
    validate_payload(kind, payload)
    config = read_config(root)
    current_session = session_id(root)
    if agent_id is not None and not SAFE_IDENTIFIER.fullmatch(agent_id):
        raise OutboxError("ADH agent binding is invalid")
    delivery_id = str(uuid.uuid4())
    envelope = {
        "schema_version": ENVELOPE_SCHEMA_VERSION,
        "delivery_id": delivery_id,
        "kind": kind,
        "repository": config["repository"],
        "session_id": current_session,
        "agent_id": agent_id,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "payload": payload,
    }
    encoded = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode()
    if len(encoded) > MAX_ENVELOPE_BYTES:
        raise OutboxError(f"ADH outbox envelope exceeds {MAX_ENVELOPE_BYTES} bytes")

    outbox = git_path(root, "adh/outbox")
    outbox.mkdir(mode=0o700, parents=True, exist_ok=True)
    if len(list(outbox.glob("pending-*.json"))) >= MAX_OUTBOX_FILES:
        raise OutboxError("ADH local outbox is full; allow a lifecycle hook to deliver it")
    descriptor, temporary = tempfile.mkstemp(prefix=".pending-", dir=outbox)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        final = outbox / f"pending-{delivery_id}.json"
        os.replace(temporary, final)
        fsync_directory(outbox)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    return {
        "queued": True,
        "delivery_id": delivery_id,
        "durability": "fsynced_local_outbox",
        "delivery": "pending_next_adh_hook",
    }


def open_envelope(path: Path) -> dict:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) & 0o077
        ):
            raise OutboxError("ADH outbox entry is not a private regular file")
        if info.st_size <= 0 or info.st_size > MAX_ENVELOPE_BYTES:
            raise OutboxError("ADH outbox entry has an invalid size")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            raw = handle.read(MAX_ENVELOPE_BYTES + 1)
    finally:
        os.close(descriptor)
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OutboxError("ADH outbox entry is not valid JSON") from error
    if not isinstance(value, dict) or set(value) != ENVELOPE_KEYS:
        raise OutboxError("ADH outbox envelope shape is invalid")
    if value.get("schema_version") != ENVELOPE_SCHEMA_VERSION:
        raise OutboxError("ADH outbox schema version is unsupported")
    try:
        parsed_id = uuid.UUID(value.get("delivery_id", ""))
    except (ValueError, AttributeError) as error:
        raise OutboxError("ADH delivery id is invalid") from error
    if str(parsed_id) != value["delivery_id"]:
        raise OutboxError("ADH delivery id is not canonical")
    if not isinstance(value.get("repository"), str) or not SAFE_REPOSITORY.fullmatch(
        value["repository"]
    ):
        raise OutboxError("ADH outbox repository is invalid")
    if not isinstance(value.get("session_id"), str) or not SAFE_IDENTIFIER.fullmatch(
        value["session_id"]
    ):
        raise OutboxError("ADH outbox session is invalid")
    agent_id = value.get("agent_id")
    if agent_id is not None and (
        not isinstance(agent_id, str) or not SAFE_IDENTIFIER.fullmatch(agent_id)
    ):
        raise OutboxError("ADH outbox agent is invalid")
    if not isinstance(value.get("payload"), dict):
        raise OutboxError("ADH outbox payload is invalid")
    created_at = value.get("created_at")
    if not isinstance(created_at, str) or len(created_at) > 64:
        raise OutboxError("ADH outbox timestamp is invalid")
    try:
        dt.datetime.fromisoformat(created_at)
    except ValueError as error:
        raise OutboxError("ADH outbox timestamp is invalid") from error
    validate_payload(value.get("kind", ""), value["payload"])
    return value


def validated_api_url() -> str:
    value = os.environ.get("ADH_API_URL", "").rstrip("/")
    parsed = urllib.parse.urlparse(value)
    local_http = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}
    if (parsed.scheme != "https" and not local_http) or not parsed.hostname:
        raise OutboxError("ADH_API_URL must be an HTTPS origin")
    if (
        parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise OutboxError(
            "ADH_API_URL must be an origin without credentials, path, query, or fragment"
        )
    return value


def curl_post(api_url: str, token: str, envelope: dict, outbox: Path) -> bool:
    endpoint = (
        "/v1/session-captures"
        if envelope["kind"] == "session_capture"
        else "/v1/research-dossiers"
    )
    body = json.dumps(
        envelope["payload"], ensure_ascii=False, separators=(",", ":")
    ).encode()
    descriptor, body_path = tempfile.mkstemp(prefix=".body-", dir=outbox)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        command = [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "3",
            "--request",
            "POST",
            "--header",
            f"Authorization: Bearer {token}",
            "--header",
            f"X-ADH-Session-ID: {envelope['session_id']}",
            "--header",
            f"X-ADH-Repository: {envelope['repository']}",
            "--header",
            f"X-ADH-Connector-Version: {CONNECTOR_VERSION}",
            "--header",
            f"X-ADH-Delivery-ID: {envelope['delivery_id']}",
            "--header",
            "Content-Type: application/json",
        ]
        if envelope["agent_id"] is not None:
            command.extend(["--header", f"X-ADH-Agent-ID: {envelope['agent_id']}"])
        command.extend(["--data-binary", f"@{body_path}", f"{api_url}{endpoint}"])
        result = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=5,
        )
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        return False
    finally:
        try:
            os.unlink(body_path)
        except OSError:
            pass


def quarantine(path: Path, outbox: Path) -> None:
    rejected = outbox / "rejected"
    rejected.mkdir(mode=0o700, exist_ok=True)
    os.replace(path, rejected / path.name)
    fsync_directory(rejected)
    fsync_directory(outbox)


def drain(root: Path, event: str) -> dict:
    api_url = validated_api_url()
    token = os.environ.get("ADH_PROJECT_TOKEN", "")
    if not token or len(token) > 2_000:
        raise OutboxError("ADH project token is unavailable")
    repository = read_config(root)["repository"]
    outbox = git_path(root, "adh/outbox")
    if not outbox.is_dir():
        return {"delivered": 0, "pending": 0}

    lock_path = outbox / ".lock"
    lock_flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    lock_descriptor = os.open(lock_path, lock_flags, 0o600)
    try:
        try:
            fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"delivered": 0, "pending": -1}
        candidates = list(outbox.glob("pending-*.json"))[:MAX_OUTBOX_FILES]
        preferred = "research" if event == "subagent-stop" else "session_capture"
        parsed: list[tuple[Path, dict]] = []
        for path in candidates:
            try:
                envelope = open_envelope(path)
                if envelope["repository"].lower() != repository.lower():
                    raise OutboxError("ADH outbox repository no longer matches this checkout")
                parsed.append((path, envelope))
            except (OSError, OutboxError):
                quarantine(path, outbox)
        parsed.sort(
            key=lambda item: (item[1]["kind"] != preferred, item[1]["created_at"])
        )
        if not parsed:
            return {"delivered": 0, "pending": 0}
        path, envelope = parsed[0]
        if not curl_post(api_url, token, envelope, outbox):
            return {"delivered": 0, "pending": len(parsed)}
        path.unlink()
        fsync_directory(outbox)
        return {"delivered": 1, "pending": len(parsed) - 1}
    finally:
        os.close(lock_descriptor)


def prime_cli(root: Path) -> dict:
    api_url = validated_api_url()
    destination = git_path(root, "adh/bin/adh-cloud")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".adh-cloud-", dir=destination.parent)
    os.close(descriptor)
    try:
        result = subprocess.run(
            [
                "curl",
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--max-time",
                "8",
                "--max-filesize",
                str(64 * 1024 * 1024),
                f"{api_url}/downloads/adh-x86_64-unknown-linux-gnu",
                "--output",
                temporary,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=10,
        )
        if result.returncode != 0 or os.path.getsize(temporary) == 0:
            return {"primed": False}
        os.chmod(temporary, 0o700)
        with open(temporary, "rb+") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        fsync_directory(destination.parent)
        return {"primed": True}
    except (OSError, subprocess.TimeoutExpired):
        return {"primed": False}
    finally:
        try:
            os.unlink(temporary)
        except OSError:
            pass


def main() -> int:
    if len(sys.argv) < 2:
        raise OutboxError("ADH outbox command is required")
    command = sys.argv[1]
    root = project_root()
    if command == "enqueue-capture":
        result = write_envelope(root, "session_capture", read_bounded_json_stream(), None)
    elif command == "enqueue-research":
        result = write_envelope(
            root,
            "research",
            read_bounded_json_stream(),
            os.environ.get("ADH_AGENT_ID") or None,
        )
    elif command == "drain":
        result = drain(root, sys.argv[2] if len(sys.argv) > 2 else "")
    elif command == "prime-cli":
        result = prime_cli(root)
    else:
        raise OutboxError("unknown ADH outbox command")
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OutboxError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
