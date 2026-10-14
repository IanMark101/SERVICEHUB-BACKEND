import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("nginx_uploads", Path(__file__).with_name("fix-nginx-uploads.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

HTTPS = """server {
    server_name api.servicehubcordova.tech;
    listen 443 ssl; # managed certificate
    ssl_certificate /etc/letsencrypt/live/api/fullchain.pem;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Authorization $http_authorization;
    }
}
"""


class UploadProxyTests(unittest.TestCase):
    def test_only_changes_api_https_proxy_and_preserves_headers_and_tls(self):
        other = HTTPS.replace("api.servicehubcordova.tech", "other.example")
        redirect = "server {\n    listen 80;\n    server_name api.servicehubcordova.tech;\n    return 301 https://$host$request_uri;\n}\n"
        updated = module.configure_upload_limit(other + redirect + HTTPS)
        self.assertEqual(updated, other + redirect + HTTPS.replace(
            "proxy_pass http://127.0.0.1:8000;", "proxy_pass http://127.0.0.1:8000;\n        client_max_body_size 10m;"))

    def test_replaces_smaller_location_override_and_retains_comment(self):
        source = HTTPS.replace("proxy_http_version", "client_max_body_size 1m; # previous limit\n        proxy_http_version")
        updated = module.configure_upload_limit(source)
        self.assertIn("client_max_body_size 10m; # previous limit", updated)
        self.assertEqual(updated.count("client_max_body_size"), 1)

    def test_repeat_run_is_idempotent(self):
        once = module.configure_upload_limit(HTTPS)
        self.assertEqual(module.configure_upload_limit(once), once)

    def test_uses_specific_upload_location_instead_of_unrelated_root(self):
        source = HTTPS.replace("    location / {", "    location /api/upload/ {\n        proxy_pass http://127.0.0.1:8000;\n        client_max_body_size 1m;\n    }\n    location / {")
        updated = module.configure_upload_limit(source)
        self.assertIn("client_max_body_size 10m;", updated)
        self.assertEqual(updated.count("client_max_body_size"), 1)
        self.assertTrue(updated.endswith(HTTPS[HTTPS.index("    location / {"):]))

    def test_fails_closed_for_unexpected_host_tls_upstream_or_duplicate_limit(self):
        for source in [HTTPS.replace(module.API_HOST, "other.example"),
                       HTTPS.replace("listen 443 ssl", "listen 80"),
                       HTTPS.replace("127.0.0.1:8000", "127.0.0.1:9000"),
                       HTTPS.replace("proxy_http_version", "client_max_body_size 1m;\n        client_max_body_size 2m;\n        proxy_http_version"),
                       HTTPS + HTTPS]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                module.configure_upload_limit(source)

    def test_rejects_unknown_regex_override(self):
        source = HTTPS.replace("    location / {", "    location ~ /api/ {\n        return 403;\n    }\n    location / {")
        with self.assertRaisesRegex(ValueError, "Regex locations"):
            module.configure_upload_limit(source)

    def test_accepts_protected_prefix_and_exact_upload_path(self):
        for location in ["^~ /api/upload/", "= /api/upload/verification"]:
            with self.subTest(location=location):
                self.assertIn("client_max_body_size 10m;", module.configure_upload_limit(HTTPS.replace("location / {", f"location {location} {{")))


if __name__ == "__main__":
    unittest.main()
