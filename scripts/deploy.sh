#!/bin/sh
set -eu

# SCP places this script in /root/scripts and the Compose file in /root/docker.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/../docker"

docker compose config --quiet

# Pull successfully before replacing the running backend container.
docker compose pull app
docker compose up -d --no-deps app
docker compose ps app
