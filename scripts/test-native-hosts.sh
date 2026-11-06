#!/usr/bin/env bash
# Real hosts, local model fixture, no host credentials. One container at a time.
set -euo pipefail
native_repo=$(cd "$(dirname "$0")/.." && pwd)
native_modules=${CROSSHEAD_TEST_NODE_MODULES:-"$native_repo/node_modules"}
native_logs=${CROSSHEAD_TEST_LOG_DIR:-"$native_repo/.native-host-test-logs"}
native_image='node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da'
native_id="crosshead-native-$(date -u +%Y%m%d%H%M%S)-$$"
native_containers=()
mkdir -p "$native_logs" "$native_repo/node_modules"
test -f "$native_repo/dist/runtime/native-host-hook.js" || { printf 'Run npm run build first.\n' >&2; exit 1; }
test -d "$native_modules/nostr-tools" || { printf 'Run npm ci first.\n' >&2; exit 1; }
docker ps -aq | sort > "$native_logs/containers-before.txt"
docker volume ls -q | sort > "$native_logs/volumes-before.txt"
native_cleanup() {
  local native_status=$?
  trap - EXIT INT TERM
  for native_container in "${native_containers[@]}"; do
    docker rm -f -v "$native_container" > /dev/null 2>&1 || native_status=1
  done
  docker ps -aq | sort > "$native_logs/containers-after.txt"
  docker volume ls -q | sort > "$native_logs/volumes-after.txt"
  # Shared machines may change independently; report differences without deleting them.
  diff -u "$native_logs/containers-before.txt" "$native_logs/containers-after.txt" > "$native_logs/container-diff.txt" || true
  diff -u "$native_logs/volumes-before.txt" "$native_logs/volumes-after.txt" > "$native_logs/volume-diff.txt" || true
  exit "$native_status"
}
trap native_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for native_host in hermes opencode; do
  native_container="$native_id-$native_host"
  native_containers+=("$native_container")
  docker run -d --name "$native_container" --cpus 2 --memory 3g --memory-swap 3g \
    --tmpfs /tmp:rw,size=384m \
    --mount "type=bind,src=$native_repo,dst=/crosshead,readonly" \
    --mount "type=bind,src=$native_modules,dst=/crosshead/node_modules,readonly" \
    "$native_image" sleep infinity > "$native_logs/$native_host-container.txt"
  docker inspect "$native_container" --format '{{.Id}} memory={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} cpus={{.HostConfig.NanoCpus}}' >> "$native_logs/$native_host-container.txt"
  docker exec "$native_container" sh -c 'mkdir /test; chown node:node /test'
  if [[ $native_host == hermes ]]; then
    docker exec "$native_container" bash -c '
      set -euo pipefail
      apt-get update -qq
      apt-get install -y -qq git python3 python3-venv ca-certificates
      python3 -m venv /opt/bootstrap
      /opt/bootstrap/bin/pip install --disable-pip-version-check uv==0.13.7
      git clone --depth 1 --branch v0.22.7 https://github.com/NousResearch/hermes-agent.git /opt/hermes
      cd /opt/hermes
      test "$(git rev-parse HEAD)" = b200f5bc60e31588ba2cb60e288029c4a54ba5fa
      UV_PYTHON_INSTALL_DIR=/opt/python /opt/bootstrap/bin/uv sync --frozen --python 3.14.10 --no-dev --no-default-groups
    ' > "$native_logs/hermes-setup.log" 2>&1
  else
    docker exec "$native_container" bash -c '
      set -euo pipefail
      npm install --global --ignore-scripts --no-audit --no-fund opencode-ai@1.19.5
      node /usr/local/lib/node_modules/opencode-ai/postinstall.mjs
      test "$(opencode --version)" = 1.19.5
    ' > "$native_logs/opencode-setup.log" 2>&1
  fi
  docker exec --user 1000:1000 "$native_container" node /crosshead/scripts/smoke-native-host.mjs "$native_host" > "$native_logs/$native_host-smoke.log" 2>&1
  docker exec "$native_container" cat "/test/$native_host-result.json" > "$native_logs/$native_host-result.json"
  if [[ $native_host == hermes ]]; then
    # Exercise a real cross-host handoff in the same fixture home. No identity
    # or checkpoint files are exported between containers or to the machine.
    docker exec "$native_container" bash -c '
      set -euo pipefail
      npm install --global --ignore-scripts --no-audit --no-fund opencode-ai@1.19.5
      node /usr/local/lib/node_modules/opencode-ai/postinstall.mjs
    ' > "$native_logs/handoff-setup.log" 2>&1
    docker exec --user 1000:1000 "$native_container" touch /test/expect-hermes
    docker exec --user 1000:1000 "$native_container" node /crosshead/scripts/smoke-native-host.mjs opencode > "$native_logs/handoff-smoke.log" 2>&1
    docker exec "$native_container" cat /test/opencode-result.json > "$native_logs/handoff-result.json"
  fi
  docker stop "$native_container" > /dev/null
done
printf 'Hermes, OpenCode, and cross-host handoff checks passed. Logs: %s\n' "$native_logs"
