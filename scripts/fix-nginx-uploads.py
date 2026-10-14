#!/usr/bin/env python3
"""Align the existing ServiceHub HTTPS upload proxy with Express's 10 MB body limit."""

import argparse
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

API_HOST = "api.servicehubcordova.tech"
UPLOAD_PATH = "/api/upload/verification"


def configure_upload_limit(text: str) -> str:
    # Scope the edit to the API HTTPS vhost, preserving redirects and other sites.
    servers = re.compile(r"(?ms)^(?P<indent>[ \t]*)server[ \t]*\{(?P<body>.*?)^(?P=indent)\}")
    matches = []
    for server in servers.finditer(text):
        names = re.search(r"(?m)^[ \t]*server_name[ \t]+([^;\n]+);", server["body"])
        tls = re.search(r"(?m)^[ \t]*listen[ \t]+[^;\n]*\b443\b[^;\n]*\bssl\b", server["body"])
        if names and API_HOST in names[1].split() and tls:
            matches.append(server)
    if len(matches) != 1:
        raise ValueError(f"Expected one HTTPS server block for {API_HOST}; no changes made")

    server = matches[0]
    body = server["body"]
    locations = re.compile(
        r"(?ms)^(?P<indent>[ \t]*)location[ \t]+(?:(?P<mode>=|\^~)[ \t]+)?"
        r"(?P<path>/[^ \t\n{]*)[ \t]*\{(?P<body>.*?)^(?P=indent)\}"
    )
    candidates = [location for location in locations.finditer(body)
                  if (location["path"] == UPLOAD_PATH if location["mode"] == "="
                      else UPLOAD_PATH.startswith(location["path"]))]
    if not candidates:
        raise ValueError("No supported upload proxy location found; no changes made")
    candidates.sort(key=lambda location: (location["mode"] == "=", len(location["path"])), reverse=True)
    location = candidates[0]
    if len(candidates) > 1 and candidates[0]["path"] == candidates[1]["path"]:
        raise ValueError("Duplicate upload proxy locations; no changes made")
    location_body = location["body"]
    if re.search(r"(?m)^[ \t]*location\b", location_body):
        raise ValueError("Nested upload locations require manual review; no changes made")
    # Regex locations can override a prefix unless ^~ prevents that lookup.
    if location["mode"] not in ("=", "^~") and re.search(r"(?m)^[ \t]*location[ \t]+~", body):
        raise ValueError("Regex locations require manual upload-route review; no changes made")
    upstream = re.search(r"(?m)^(?P<indent>[ \t]*)proxy_pass[ \t]+http://127\.0\.0\.1:8000;[ \t]*(?:#.*)?$", location_body)
    if not upstream:
        raise ValueError("Upload location must proxy to http://127.0.0.1:8000; no changes made")
    directive = re.compile(r"(?m)^([ \t]*)client_max_body_size[ \t]+[^;\n]+;([ \t]*(?:#.*)?)$")
    existing = list(directive.finditer(location_body))
    if len(existing) > 1:
        raise ValueError("Duplicate client_max_body_size directives; no changes made")
    if existing:
        updated_location = directive.sub(lambda match: f"{match[1]}client_max_body_size 10m;{match[2]}", location_body)
    else:
        updated_location = (location_body[:upstream.end()] +
                            f"\n{upstream['indent']}client_max_body_size 10m;" +
                            location_body[upstream.end():])
    updated_server = body[:location.start("body")] + updated_location + body[location.end("body"):]
    return text[:server.start("body")] + updated_server + text[server.end("body"):]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", nargs="?", default="/etc/nginx/sites-enabled/api.servicehubcordova.tech")
    parser.add_argument("--check", action="store_true", help="Print the proposed edit without writing or reloading")
    args = parser.parse_args()
    config = Path(args.config).resolve(strict=True)
    original = config.read_text()
    updated = configure_upload_limit(original)
    if args.check:
        import difflib
        print("".join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                          fromfile=str(config), tofile=str(config))), end="")
        return 0
    for command in ("nginx", "systemctl"):
        if not shutil.which(command):
            raise RuntimeError(f"{command} is not available; run this on the backend VPS")
    subprocess.run(["nginx", "-t"], check=True)
    if original == updated:
        print("Upload proxy already has client_max_body_size 10m; no change needed.")
        return 0
    backup = config.with_name(f"{config.name}.before-uploads-{time.time_ns()}.bak")
    # Keep the backup outside sites-enabled so Nginx cannot load a second vhost.
    backup = Path("/root") / backup.name
    shutil.copy2(config, backup)
    print(f"Backup: {backup}", flush=True)
    try:
        config.write_text(updated)
        subprocess.run(["nginx", "-t"], check=True)
        subprocess.run(["systemctl", "reload", "nginx"], check=True)
    except (OSError, subprocess.CalledProcessError):
        shutil.copy2(backup, config)
        print("Restored the previous configuration after validation/reload failed.", file=sys.stderr)
        raise
    print("ServiceHub upload proxy limit is 10m. The application still enforces 5 MB per verification photo.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Upload proxy repair failed: {error}", file=sys.stderr)
        sys.exit(1)
