#!/bin/sh
set -eu

# SCP places this script in /root/scripts and the Compose file in /root/docker.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/../docker"

docker compose config --quiet

# Pull successfully before replacing the running backend container.
docker compose --profile migration pull app migrate
# Never start a new client against an older schema. A migration failure exits
# before up, leaving the existing API container running. No reset or seed runs.
docker compose run --rm --no-deps -T migrate
docker compose up -d --no-deps app
docker compose ps app
