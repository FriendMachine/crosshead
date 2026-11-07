#!/usr/bin/env bash
# Claude Code and Codex plugin end-to-end check in one disposable container.
# Real host CLIs, local model/installer fixture, no credentials.
# Requires `npm ci && npm run release:build` (dist/ and release/).
set -euo pipefail
plugin_repo=$(cd "$(dirname "$0")/.." && pwd)
plugin_logs=${CROSSHEAD_TEST_LOG_DIR:-"$plugin_repo/.native-host-test-logs/host-plugins"}
# A prebuilt image with both CLIs may be supplied; otherwise they are installed at the pinned versions.
plugin_image=${CROSSHEAD_PLUGIN_TEST_IMAGE:-'node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da'}
claude_version=${CROSSHEAD_TEST_CLAUDE_VERSION:-2.1.319}
codex_version=${CROSSHEAD_TEST_CODEX_VERSION:-0.167.0}
plugin_container=${CROSSHEAD_PLUGIN_TEST_CONTAINER:-"crosshead-host-plugins-$(date -u +%Y%m%d%H%M%S)-$$"}
version=$(node -p 'require(process.argv[1]).version' "$plugin_repo/package.json")
test -f "$plugin_repo/dist/runtime/host-hook-spec.js" || { printf 'Run npm run build first.\n' >&2; exit 1; }
test -f "$plugin_repo/release/crosshead-runtime-install-$version.tgz" || { printf 'Run npm run release:build first.\n' >&2; exit 1; }
mkdir -p "$plugin_logs"
docker ps -aq | sort > "$plugin_logs/containers-before.txt"
docker volume ls -q | sort > "$plugin_logs/volumes-before.txt"
plugin_cleanup() {
  local plugin_status=$?
  trap - EXIT INT TERM
  docker rm -f -v "$plugin_container" > /dev/null 2>&1 || true
  if docker ps -a --format '{{.Names}}' | grep -qx "$plugin_container"; then plugin_status=1; fi
  docker ps -aq | sort > "$plugin_logs/containers-after.txt"
  docker volume ls -q | sort > "$plugin_logs/volumes-after.txt"
  diff -u "$plugin_logs/containers-before.txt" "$plugin_logs/containers-after.txt" > "$plugin_logs/container-diff.txt" || true
  diff -u "$plugin_logs/volumes-before.txt" "$plugin_logs/volumes-after.txt" > "$plugin_logs/volume-diff.txt" || true
  exit "$plugin_status"
}
trap plugin_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run -d --rm --name "$plugin_container" --cpus 2 --memory 3g --memory-swap 3g \
  --tmpfs /tmp:rw,size=384m --tmpfs /test:rw,exec,size=768m,uid=1000,gid=1000 \
  --mount "type=bind,src=$plugin_repo,dst=/crosshead,readonly" \
  --user 0:0 "$plugin_image" sleep infinity > "$plugin_logs/container.txt"
docker inspect "$plugin_container" --format '{{.Id}} memory={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} cpus={{.HostConfig.NanoCpus}}' >> "$plugin_logs/container.txt"
docker exec "$plugin_container" bash -c "
  set -euo pipefail
  command -v curl > /dev/null || { apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl; }
  if ! claude --version 2> /dev/null | grep -q '^$claude_version ' || ! codex --version 2> /dev/null | grep -q ' $codex_version\$'; then
    npm install --global --no-audit --no-fund @anthropic-ai/claude-code@$claude_version @openai/codex@$codex_version
  fi
  claude --version; codex --version
" > "$plugin_logs/setup.log" 2>&1
plugin_status=0
docker exec --user 1000:1000 "$plugin_container" node /crosshead/scripts/smoke-host-plugins.mjs > "$plugin_logs/smoke.log" 2>&1 || plugin_status=$?
docker exec "$plugin_container" cat /test/host-plugins-result.json > "$plugin_logs/result.json" 2> /dev/null || true
docker exec "$plugin_container" tar -C /test -cf - logs 2> /dev/null | tar -C "$plugin_logs" -xf - 2> /dev/null || true
if [[ $plugin_status -ne 0 ]]; then
  printf 'Host plugin checks failed (exit %s). Logs: %s\n' "$plugin_status" "$plugin_logs" >&2
  exit "$plugin_status"
fi
printf 'Claude Code and Codex plugin checks passed. Logs: %s\n' "$plugin_logs"
