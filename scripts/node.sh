#!/bin/sh
# Runs Node.js for the Taskfile (scripts/changelog.mjs), whichever way this machine has it:
#
#   1. $NODE, when set: another Node.js command (one executable path, which gets the arguments).
#   2. node, when it's installed.
#   3. Otherwise Docker, with the node:22-alpine image: no network, as the current user, with only
#      the current folder mounted, and at most half the machine's memory (on Linux).
#
# `sh scripts/node.sh --which` prints the command it would use, or fails, without running Node.js.
set -eu

if [ -n "${NODE:-}" ]; then
  command -v "$NODE" >/dev/null 2>&1 || { echo "Missing required tool: $NODE (set as NODE)" >&2; exit 1; }
  how=$NODE
elif command -v node >/dev/null 2>&1; then
  how=node
elif command -v docker >/dev/null 2>&1; then
  how=docker
else
  echo "Missing required tool: Node.js. Install Node.js or Docker, or set NODE to another Node.js command." >&2
  exit 1
fi

if [ "${1:-}" = --which ]; then
  if [ "$how" = docker ]; then echo 'docker (node:22-alpine)'; else echo "$how"; fi
  exit 0
fi

[ "$how" = docker ] || exec "$how" "$@"

echo 'Node.js not found; using Docker (node:22-alpine)' >&2
# Half the machine's memory, so a runaway script can't take all of it.
if [ -r /proc/meminfo ]; then
  cap_mb=$(awk '/MemTotal/ { print int($2 / 1024 / 2) }' /proc/meminfo)
  set -- --memory "${cap_mb}m" --memory-swap "${cap_mb}m" \
    -e NODE_OPTIONS="--max-old-space-size=$((cap_mb > 2048 ? cap_mb - 1024 : cap_mb / 2))" \
    node:22-alpine node "$@"
else
  set -- node:22-alpine node "$@"
fi
exec docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "$PWD":"$PWD" -w "$PWD" -e HOME=/tmp "$@"
