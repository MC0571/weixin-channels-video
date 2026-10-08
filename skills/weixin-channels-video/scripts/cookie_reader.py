#!/usr/bin/env python3
"""Read URL-matching Chrome cookies without copying or modifying its profile."""

import argparse
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlsplit


TARGET_HOST = "yuanbao.tencent.com"
NT_EPOCH_OFFSET = 11_644_473_600


class CookieReaderError(Exception):
    pass


def _domain_candidates(host):
    if host != TARGET_HOST:
        raise CookieReaderError("unsupported-cookie-domain")
    return [host, f".{host}", ".tencent.com"]


def _domain_matches(host_key, request_host):
    host_only = not host_key.startswith(".")
    domain = host_key.lstrip(".").lower()
    if host_only:
        return request_host == domain
    return request_host == domain or request_host.endswith(f".{domain}")


def _path_matches(cookie_path, request_path):
    if request_path == cookie_path:
        return True
    if not request_path.startswith(cookie_path):
        return False
    return cookie_path.endswith("/") or request_path[len(cookie_path)] == "/"


def _eligible(row, request_host, request_path, secure_request, now):
    host_key, path, secure, expires_utc, name, value, encrypted_value, http_only = row
    if not _domain_matches(host_key, request_host) or not _path_matches(path, request_path):
        return False
    if secure and not secure_request:
        return False
    if expires_utc:
        expires = expires_utc / 1_000_000 - NT_EPOCH_OFFSET
        if expires <= now:
            return False
    return True


def _check_database_closed(cookie_db, run=None):
    try:
        result = (run or subprocess.run)(
            ["/usr/sbin/lsof", "-t", "--", str(cookie_db)],
            capture_output=True,
            check=False,
        )
    except OSError as error:
        raise CookieReaderError("cookie-database-open-check-failed") from error
    if result.returncode == 0:
        raise CookieReaderError("cookie-database-open-close-chrome")
    if result.returncode != 1:
        raise CookieReaderError("cookie-database-open-check-failed")


def _check_wal_checkpointed(cookie_db):
    wal_path = Path(f"{cookie_db}-wal")
    try:
        if wal_path.stat().st_size:
            raise CookieReaderError("cookie-database-wal-pending-close-chrome")
    except FileNotFoundError:
        return
    except OSError as error:
        raise CookieReaderError("cookie-database-wal-check-failed") from error


def select_cookie_rows(cookie_db, request_url, now=None):
    parsed = urlsplit(request_url)
    request_host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or request_host != TARGET_HOST or parsed.username or parsed.password or parsed.fragment:
        raise CookieReaderError("unsupported-cookie-url")
    request_path = parsed.path or "/"
    candidates = _domain_candidates(request_host)
    _check_wal_checkpointed(cookie_db)
    uri = f"file:{quote(str(Path(cookie_db).resolve()), safe='/')}?mode=ro&immutable=1"

    try:
        with sqlite3.connect(uri, uri=True) as connection:
            columns = {column[1] for column in connection.execute("PRAGMA table_info(cookies)")}
            secure_column = "is_secure" if "is_secure" in columns else "secure"
            required = {"host_key", "path", secure_column, "expires_utc", "name", "value", "encrypted_value", "is_httponly"}
            if not required <= columns:
                raise CookieReaderError("invalid-cookie-database")
            placeholders = ",".join("?" for _ in candidates)
            rows = connection.execute(
                f"SELECT host_key, path, {secure_column}, expires_utc, name, value, encrypted_value, is_httponly "
                f"FROM cookies WHERE host_key IN ({placeholders})",
                candidates,
            ).fetchall()
            try:
                version = connection.execute('SELECT value FROM meta WHERE key = "version"').fetchone()
                integrity_check = version is not None and int(version[0]) >= 24
            except (sqlite3.OperationalError, TypeError, ValueError):
                integrity_check = False
    except sqlite3.OperationalError as error:
        raise CookieReaderError("cookie-database-unavailable-read-only") from error

    now = time.time() if now is None else now
    selected = [row for row in rows if _eligible(row, request_host, request_path, parsed.scheme == "https", now)]
    selected.sort(key=lambda row: -len(row[1]))
    return selected, integrity_check


def cookie_pairs(cookie_db, request_url, decrypt, now=None):
    rows, integrity_check = select_cookie_rows(cookie_db, request_url, now)
    return decode_cookie_rows(rows, integrity_check, decrypt)


def decode_cookie_rows(rows, integrity_check, decrypt):
    pairs = []
    for row in rows:
        host, path, secure, expires, name, value, encrypted_value, http_only = row
        value = decrypt(value, encrypted_value, integrity_check)
        if not isinstance(name, str) or not name or any(
            not (char.isascii() and (char.isalnum() or char in "!#$%&'*+-.^_`|~")) for char in name
        ):
            raise CookieReaderError("invalid-cookie-name")
        if not isinstance(value, str) or any(ord(char) < 0x20 or ord(char) == 0x7F or char == ";" for char in value):
            raise CookieReaderError("invalid-cookie-value")
        pairs.append((name, value))
    return pairs


def _main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cookie-db", required=True)
    parser.add_argument("--url", action="append", required=True)
    args = parser.parse_args()

    if sys.platform != "darwin":
        print("macOS Chrome cookie reading is supported on macOS only.", file=sys.stderr)
        return 2
    try:
        _check_database_closed(args.cookie_db)
    except CookieReaderError as error:
        print(f"Cookie read failed: {error}.", file=sys.stderr)
        return 1
    try:
        import browser_cookie3
        from importlib.metadata import PackageNotFoundError, version
    except ImportError:
        print("browser-cookie3 is missing; install the skill's requirements.txt.", file=sys.stderr)
        return 2
    try:
        installed_version = version("browser-cookie3")
    except PackageNotFoundError:
        print("browser-cookie3 is missing; install the skill's requirements.txt.", file=sys.stderr)
        return 2
    if installed_version != "0.20.1":
        print("browser-cookie3 version mismatch; install the skill's requirements.txt.", file=sys.stderr)
        return 2

    try:
        selected = [(url, *select_cookie_rows(args.cookie_db, url)) for url in args.url]
        if not any(rows for _, rows, _ in selected):
            result = [{"url": url, "cookies": []} for url, _, _ in selected]
            print(json.dumps({"cookiesByUrl": result}, separators=(",", ":")))
            return 0
        needs_key = any(
            not row[5] and row[6][:3] in (b"v10", b"v11")
            for _, rows, _ in selected
            for row in rows
        )
        if needs_key:
            # ponytail: pin browser-cookie3 because its public loader may copy a locked DB; upgrade with the read-only tests.
            chrome = browser_cookie3.Chrome(cookie_file=args.cookie_db, domain_name=TARGET_HOST)
            decrypt = chrome._decrypt
        else:
            decrypt = lambda value, encrypted, has_integrity: value
        result = [
            {"url": url, "cookies": decode_cookie_rows(rows, integrity_check, decrypt)}
            for url, rows, integrity_check in selected
        ]
    except CookieReaderError as error:
        print(f"Cookie read failed: {error}.", file=sys.stderr)
        return 1
    except (browser_cookie3.BrowserCookieError, RuntimeError, ValueError, AssertionError):
        print("Cookie read failed: Keychain access or cookie decryption failed.", file=sys.stderr)
        return 1

    print(json.dumps({"cookiesByUrl": result}, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
