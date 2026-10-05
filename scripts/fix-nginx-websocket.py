#!/usr/bin/env python3
"""Repair the existing ServiceHub HTTPS proxy without changing its TLS settings."""

import argparse
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


def configure_websocket(text: str) -> str:
    if not re.search(r"server_name\s+api\.servicehubcordova\.tech\s*;", text):
        raise ValueError("The configuration does not serve api.servicehubcordova.tech")
    if not re.search(r"listen\s+443\s+ssl", text):
        raise ValueError("The expected HTTPS server block was not found")

    locations = re.compile(
        r"(?ms)^(?P<indent>[ \t]*)location[ \t]+/[ \t]*\{"
        r"(?P<body>.*?)^(?P=indent)\}"
    )
    upstream = re.compile(
        r"(?m)^(?P<indent>[ \t]*)proxy_pass[ \t]+http://127\.0\.0\.1:8000;[ \t]*(?:#.*)?$"
    )
    matches = [match for match in locations.finditer(text) if upstream.search(match["body"])]
    if len(matches) != 1:
        raise ValueError("Expected one location / proxying to http://127.0.0.1:8000")

    location = matches[0]
    body = location["body"]
    required = (
        ("proxy_http_version", "1.1"),
        ("proxy_set_header Upgrade", "$http_upgrade"),
        ("proxy_set_header Connection", '"upgrade"'),
        ("proxy_read_timeout", "75s"),
        ("proxy_send_timeout", "75s"),
    )
    missing = []
    for directive, value in required:
        pattern = re.compile(
            r"(?m)^([ \t]*)" + re.escape(directive) + r"[ \t]+[^;\n]+;[ \t]*(?:#.*)?$"
        )
        existing = list(pattern.finditer(body))
        if len(existing) > 1:
            raise ValueError(f"Duplicate {directive} directives; review this location manually")
        if existing:
            body = pattern.sub(lambda match: f"{match[1]}{directive} {value};", body)
        else:
            missing.append(f"{directive} {value};")

    anchor = upstream.search(body)
    if missing:
        insertion = "".join(f"\n{anchor['indent']}{line}" for line in missing)
        body = body[:anchor.end()] + insertion + body[anchor.end():]
    return text[:location.start("body")] + body + text[location.end("body"):]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", nargs="?", default="/etc/nginx/sites-enabled/api.servicehubcordova.tech")
    args = parser.parse_args()
    for command in ("nginx", "systemctl"):
        if not shutil.which(command):
            raise RuntimeError(f"{command} is not available; run this on the backend server")

    config = Path(args.config).resolve(strict=True)
    original = config.read_text()
    updated = configure_websocket(original)
    backup = None
    if updated != original:
        backup = Path("/root") / f"servicehub-nginx-before-websocket-{time.time_ns()}.conf"
        shutil.copy2(config, backup)
        print(f"Backup: {backup}", flush=True)

    try:
        if backup:
            config.write_text(updated)
        subprocess.run(["nginx", "-t"], check=True)
        subprocess.run(["systemctl", "reload", "nginx"], check=True)
    except (OSError, subprocess.CalledProcessError):
        if backup:
            shutil.copy2(backup, config)
            print("Restored the previous configuration after validation/reload failed.", file=sys.stderr)
        raise

    print("Nginx WebSocket forwarding configured and reloaded.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"WebSocket repair failed: {error}", file=sys.stderr)
        sys.exit(1)
