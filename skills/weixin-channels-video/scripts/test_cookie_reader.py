import contextlib
import io
import json
import sqlite3
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from cookie_reader import CookieReaderError, NT_EPOCH_OFFSET, _check_database_closed, _main, cookie_pairs, select_cookie_rows


class CookieReaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.cookie_db = self.root / "Cookies"
        with sqlite3.connect(self.cookie_db) as connection:
            connection.execute(
                "CREATE TABLE cookies (host_key TEXT, path TEXT, is_secure INTEGER, expires_utc INTEGER, "
                "name TEXT, value TEXT, encrypted_value BLOB, is_httponly INTEGER)"
            )
            connection.execute("CREATE TABLE meta (key TEXT, value TEXT)")
            connection.execute("INSERT INTO meta VALUES ('version', '23')")

    def tearDown(self):
        self.temporary.cleanup()

    def add(self, host, path, name, value, secure=0, expires=0):
        expires_nt = 0 if expires == 0 else int((expires + NT_EPOCH_OFFSET) * 1_000_000)
        with sqlite3.connect(self.cookie_db) as connection:
            connection.execute(
                "INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (host, path, secure, expires_nt, name, value, b"", 0),
            )

    def test_selects_only_url_matching_target_domain_cookies(self):
        now = 2_000_000_000
        self.add("yuanbao.tencent.com", "/api", "host", "fake-host-cookie", secure=1, expires=now + 60)
        self.add(".tencent.com", "/", "domain", "fake-domain-cookie", secure=0)
        self.add("yuanbao.tencent.com", "/chat", "wrong-path", "fake-path-cookie")
        self.add(".tencent.com", "/", "expired", "fake-expired-cookie", expires=now - 1)
        self.add("bad-tencent.com", "/", "wrong-domain", "fake-unrelated-cookie")

        rows, integrity_check = select_cookie_rows(
            self.cookie_db,
            "https://yuanbao.tencent.com/api/getuserinfo",
            now=now,
        )
        self.assertFalse(integrity_check)
        self.assertEqual([row[4] for row in rows], ["host", "domain"])
        pairs = cookie_pairs(
            self.cookie_db,
            "https://yuanbao.tencent.com/api/getuserinfo",
            lambda value, encrypted, integrity: value,
            now=now,
        )
        self.assertEqual(pairs, [("host", "fake-host-cookie"), ("domain", "fake-domain-cookie")])
        self.assertEqual([path.name for path in self.root.iterdir()], ["Cookies"])

    def test_host_only_and_domain_cookie_matching_follow_url_host_rules(self):
        from cookie_reader import _domain_matches

        self.assertTrue(_domain_matches("yuanbao.tencent.com", "yuanbao.tencent.com"))
        self.assertFalse(_domain_matches("yuanbao.tencent.com", "sub.yuanbao.tencent.com"))
        self.assertTrue(_domain_matches(".tencent.com", "yuanbao.tencent.com"))
        self.assertFalse(_domain_matches("tencent.com", "yuanbao.tencent.com"))
        self.assertFalse(_domain_matches(".tencent.com", "not-tencent.com"))

    def test_path_scopes_are_selected_separately_for_api_urls(self):
        now = 2_000_000_000
        self.add("yuanbao.tencent.com", "/api/getuserinfo", "userinfo", "fake-userinfo-cookie")
        self.add("yuanbao.tencent.com", "/api/weixin/get_parse_result", "parse", "fake-parse-cookie")

        user_rows, _ = select_cookie_rows(
            self.cookie_db,
            "https://yuanbao.tencent.com/api/getuserinfo",
            now=now,
        )
        parse_rows, _ = select_cookie_rows(
            self.cookie_db,
            "https://yuanbao.tencent.com/api/weixin/get_parse_result",
            now=now,
        )
        self.assertEqual([row[4] for row in user_rows], ["userinfo"])
        self.assertEqual([row[4] for row in parse_rows], ["parse"])

    def test_immutable_read_of_checkpointed_wal_database_creates_no_sidecars(self):
        self.add("yuanbao.tencent.com", "/api", "safe", "fake-value")
        connection = sqlite3.connect(self.cookie_db)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            connection.close()
        self.assertFalse(Path(f"{self.cookie_db}-wal").exists())
        self.assertFalse(Path(f"{self.cookie_db}-shm").exists())

        rows, _ = select_cookie_rows(self.cookie_db, "https://yuanbao.tencent.com/api/getuserinfo")
        self.assertEqual([row[4] for row in rows], ["safe"])
        self.assertEqual([path.name for path in self.root.iterdir()], ["Cookies"])

    def test_helper_batches_per_url_cookie_headers_in_one_child(self):
        self.add("yuanbao.tencent.com", "/api/getuserinfo", "userinfo", "alpha")
        self.add("yuanbao.tencent.com", "/api/weixin/get_parse_result", "parse", "beta")
        user_url = "https://yuanbao.tencent.com/api/getuserinfo"
        parse_url = "https://yuanbao.tencent.com/api/weixin/get_parse_result"
        stdout = io.StringIO()
        browser_cookie_stub = types.SimpleNamespace(BrowserCookieError=Exception)
        argv = [
            "cookie_reader.py",
            "--cookie-db", str(self.cookie_db),
            "--url", user_url,
            "--url", parse_url,
        ]
        with (
            patch("sys.argv", argv),
            patch("sys.platform", "darwin"),
            patch("cookie_reader.subprocess.run", return_value=types.SimpleNamespace(returncode=1)),
            patch.dict("sys.modules", {"browser_cookie3": browser_cookie_stub}),
            patch("importlib.metadata.version", return_value="0.20.1"),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(_main(), 0)

        self.assertEqual(json.loads(stdout.getvalue()), {
            "cookiesByUrl": [
                {"url": user_url, "cookies": [["userinfo", "alpha"]]},
                {"url": parse_url, "cookies": [["parse", "beta"]]},
            ],
        })

    def test_rejects_a_database_with_a_pending_wal(self):
        connection = sqlite3.connect(self.cookie_db)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                "INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("yuanbao.tencent.com", "/", 0, 0, "fake", "value", b"", 0),
            )
            connection.commit()
            wal_path = Path(f"{self.cookie_db}-wal")
            self.assertGreater(wal_path.stat().st_size, 0)
            with self.assertRaisesRegex(CookieReaderError, "cookie-database-wal-pending-close-chrome"):
                select_cookie_rows(self.cookie_db, "https://yuanbao.tencent.com/api/getuserinfo")
        finally:
            connection.close()

    def test_lsof_open_or_failed_checks_stop_cookie_access(self):
        with self.assertRaisesRegex(CookieReaderError, "cookie-database-open-close-chrome"):
            _check_database_closed(self.cookie_db, lambda *args, **kwargs: types.SimpleNamespace(returncode=0))
        with self.assertRaisesRegex(CookieReaderError, "cookie-database-open-check-failed"):
            _check_database_closed(self.cookie_db, lambda *args, **kwargs: types.SimpleNamespace(returncode=2))
        _check_database_closed(self.cookie_db, lambda *args, **kwargs: types.SimpleNamespace(returncode=1))

    def test_path_secure_and_expiry_rules(self):
        from cookie_reader import _eligible

        row = (".tencent.com", "/api", 1, int((100 + NT_EPOCH_OFFSET) * 1_000_000), "name", "value", b"", 0)
        self.assertFalse(_eligible(row, "yuanbao.tencent.com", "/apix", True, 50))
        self.assertFalse(_eligible(row, "yuanbao.tencent.com", "/api", False, 50))
        self.assertFalse(_eligible(row, "yuanbao.tencent.com", "/api", True, 101))
        self.assertTrue(_eligible(row, "yuanbao.tencent.com", "/api/user", True, 50))

    def test_rejects_non_target_cookie_urls(self):
        with self.assertRaisesRegex(Exception, "unsupported-cookie-url"):
            select_cookie_rows(self.cookie_db, "https://channels.weixin.qq.com/api")


if __name__ == "__main__":
    unittest.main()
