# Hermes and OpenCode plugins

These native plugins use the same Crosshead profile, authenticated local daemon,
workspace scoping, memory modes, and durable hot memory as the other adapters.
No provider API key is copied into Crosshead. No telemetry is added.

## Setup

Install Hermes or OpenCode before installing its adapter. For a new profile:

```sh
crosshead quickstart --api-base https://crosshead.sh --adapter hermes --workspace-root .
crosshead quickstart --api-base https://crosshead.sh --adapter opencode --workspace-root .
```

Or attach an existing profile:

```sh
crosshead install hermes --profile default
crosshead install opencode --profile default
```

Restart the host after installing, updating, or uninstalling a plugin. In the
project directory, run the host normally. Crosshead loads saved context before
the turn and captures the final assistant response afterwards. Include findings,
verification, open questions, and next steps in that response so the next host
can continue. Use the same Crosshead home/profile and workspace in each host;
use `crosshead workspace link` for worktrees or different checkout paths.

Hermes installs a dependency-free Python plugin under
`$HERMES_HOME/plugins/crosshead/` (default `~/.hermes`). Crosshead invokes
`hermes plugins enable crosshead` with that exact `HERMES_HOME`; Hermes manages
its own YAML. The plugin uses `pre_llm_call` for context and `post_llm_call`
for successful completed turns. Correlated `on_session_end` notifications
record interruptions and failures without copying provider error details.
Terminal `api_request_error` notifications cover fatal errors that bypass
Hermes's end callback; transient attempts do not create failure checkpoints.
Its workspace comes from Hermes's session-scoped plugin context, so sessions
in a shared gateway do not use the gateway's process directory.

OpenCode installs a local JavaScript plugin at
`${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/crosshead.js`. It preserves
`opencode.json`/`opencode.jsonc`, uses native system-context transformation,
captures completed assistant messages on session idle, and records failures
without copying provider error text or tool output. Compaction keeps the
Crosshead context available, and resumed sessions can recover from host history.

Custom locations are explicit:

```sh
crosshead install hermes --home /path/to/runtime --hermes-home /path/to/hermes --hermes-bin /path/to/hermes-command --profile work
crosshead install opencode --home /path/to/runtime --opencode-home /path/to/opencode-config --profile work
```

The selected Crosshead home and profile are stored in the installed plugin;
switching provider logins does not change that Crosshead identity. Global host
plugins apply to that host's projects, with memory partitioned by workspace.
For separate identities, use separate host homes and explicit Crosshead homes.
Do not mount your real home or credentials into test containers.

## Controls and removal

`crosshead memory mode off` disables automatic context injection and capture;
`manual` leaves capture to explicit memory operations. `assist` and `auto` use
the existing Crosshead capture policy. Memory delivery failures produce a
diagnostic warning and allow the host to continue.

```sh
crosshead status
crosshead doctor
crosshead uninstall hermes
crosshead uninstall opencode
```

Removal only touches Crosshead-managed plugin files and adapter records. An
unrelated plugin at the same path is never overwritten or removed. Hermes's
own disable command is used when available. Updating the runtime reapplies the
plugins from the selected release; downgrading to a release without these
plugins is rejected before replacing the runtime.

## Verification

The release contracts used for implementation are Hermes Agent `v0.22.7`
(`b200f5bc60e31588ba2cb60e288029c4a54ba5fa`) and OpenCode `v1.19.5`
(`810c0eba1a7348036f8bdf61e6632d0c36c6876c`). OpenCode's experimental hook
names may change in future versions; run the integration check before upgrading.

`tests/runtime/native-host-plugins.test.ts` covers native callback registration,
session and turn correlation, duplicate events, failure handling, compaction,
resumed sessions, synthetic/tool-text exclusion, and managed file protections.

`scripts/smoke-native-host.mjs hermes|opencode` runs inside a disposable container
with the actual host installed at the paths in that script. It uses a local
OpenAI-compatible fixture with no paid model calls. It checks the actual
provider-bound request for Crosshead context, final-response capture, fresh
session recovery after daemon restart, actual session resume, nondefault-profile
routing, workspace isolation, off/manual capture suppression, sanitized provider
failures, and uninstall. Compaction, queued turns, retry exhaustion, recovery
after an error, and interruption callbacks have regression coverage; the Docker
fixture does not force native compaction or interruption.
Keep host sources and Node dependencies read-only at `/crosshead`, and run as
an unprivileged user with a writable `/test`. Bound container CPU, RAM, swap,
and tmpfs, and remove the exact container and its volumes when finished.

For a complete repeatable Docker run, after `npm ci && npm run build`:

```sh
bash scripts/test-native-hosts.sh
```

The wrapper pins the Node image and host releases, runs each host as UID 1000
with 2 CPUs, 3 GiB RAM, no additional swap, and a 384 MiB tmpfs. It also checks
Hermes-to-OpenCode continuity in one fixture home. Generated identity secrets
stay in the disposable container. An EXIT trap removes exactly the task's
containers and volumes; before/after inventories and logs remain in the ignored
`.native-host-test-logs/` directory.

This verifies host lifecycle integration, not inference quality or hosted
billing/sync availability. No production service changes are required for local
capture and injection.
