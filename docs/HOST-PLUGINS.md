# Claude Code and Codex plugins

Claude Code and Codex install Crosshead as a plugin from this repository's
marketplace. The plugin replaces the hooks that `crosshead install claude-code`
and `crosshead install codex` used to write into host configuration. The runtime
is still installed by `curl -fsSL https://crosshead.sh/install | bash`.

```sh
claude plugin marketplace add FriendMachine/crosshead
claude plugin install crosshead@crosshead
codex plugin marketplace add FriendMachine/crosshead
codex plugin add crosshead@crosshead
```

## What the plugin contains

| File | Purpose |
| --- | --- |
| `hooks/hooks.json` | `SessionStart`, `PreCompact`, `PostCompact`, `UserPromptSubmit` and `Stop` hooks |
| `scripts/crosshead-hook` | POSIX `sh` launcher the hooks run |
| `skills/setup/SKILL.md` | `/crosshead:setup` (Claude Code) or `$crosshead:setup` (Codex), user-invoked only |
| `skills/setup/agents/openai.yaml` (Codex) | `allow_implicit_invocation: false` |
| `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` | Manifest |

The launcher locates the runtime home the way the installer does: the first
non-empty `CROSSHEAD_HOME`, `CROSSHEAD_RUNTIME_HOME`, `ONLYBOTS_HOME` or
`ONLYBOTS_RUNTIME_HOME`, else `~/.crosshead` (or `~/.onlybots` when only that
exists). If both `~/.crosshead` and `~/.onlybots` exist as separate
installations, it prints the runtime's "choose one with `CROSSHEAD_HOME`"
notice instead of picking one. It then runs the installed
`crosshead-claude-code-hook` or `crosshead-codex-hook` with `--via plugin`.
These are the hook entrypoints the installer-written hooks use. The launcher
does not read host configuration: the runtime finds the adapter configuration
itself (the host's `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, else the directory recorded
at install time), so `--claude-home` and `--codex-home` installs work. The
launcher never downloads, installs or updates code. Without a configured
runtime, it prints one line on `SessionStart`, prints nothing for other events,
and exits 0:

```text
Crosshead isn't set up. To set it up, run /crosshead:setup.
Crosshead isn't set up. To set it up, type $crosshead:setup.
```

The line is a `systemMessage` only: the user sees it, and it is not added to
the model's context, so nothing invites the model to run setup. The setup skill
is user-invoked only (`disable-model-invocation: true` in Claude Code;
`policy.allow_implicit_invocation: false` in Codex, where an explicit
`$crosshead:setup` still works). If the runtime's hook wrapper predates plugin
dispatch (it lacks the `crosshead-hook-capability` marker), the line asks you
to run setup to update it, and the plugin stays inactive, so older
installer-written hooks keep working without duplicates.

The launcher is POSIX `sh`. Windows is not supported.

The setup skill explains what it is about to do, asks for consent, runs the
digest-checked installer, and then runs:

```sh
crosshead quickstart --api-base https://crosshead.sh --adapter claude-code --workspace-root . --hook-mode plugin
crosshead quickstart --api-base https://crosshead.sh --adapter codex --workspace-root . --hook-mode plugin
```

`--hook-mode plugin` writes the adapter configuration and wrappers but no host
hooks. Codex additionally requires you to trust the plugin hooks in `/hooks`;
a new plugin version needs a new review. The plugins have no MCP server and
ask for no credentials. The Codex marketplace entry still carries
`policy.authentication: "ON_INSTALL"` because Codex requires both policy fields
on every entry and documents no other value.

When `quickstart` finds a daemon already running, it compares the daemon's
release (its health response reports its entry script) with the installed one.
A daemon left on another release is restarted on the installed release through
the ownership-checked stop/start path. If that is not safe (a legacy daemon
without ownership records, or one hosting an organizational worker), quickstart
reports the mismatch instead. `--port` applies when quickstart starts or
restarts the daemon; if a current daemon already runs on another port,
quickstart reports that rather than ignoring the flag.

## One hook table

`src/runtime/host-hook-spec.ts` lists the hook events, matchers, Codex status
messages and timeouts. The installer-written hooks and the generated plugin
files are both rendered from it. `scripts/host-plugins.mjs` generates
`plugins/`, `.claude-plugin/marketplace.json` and
`.agents/plugins/marketplace.json`. CI runs `npm run plugins:check`, and
`tests/runtime/host-plugins.test.ts` fails if a checked-in file differs from the
generated output. Edit the spec or the generator, never the generated files,
then run `npm run build && npm run plugins:generate`. Raise
`CROSSHEAD_HOST_PLUGIN_VERSION` whenever generated content changes: hosts pin
installed plugins to their manifest version. `host-plugins.test.ts` pins a
SHA-256 of the generated `plugins/` content per version and fails when the
content changes without a new version entry.

Claude Code reads `.claude-plugin/marketplace.json`. Codex reads
`.agents/plugins/marketplace.json` first and would otherwise fall back to the
Claude file. Both list one plugin, `crosshead@crosshead`, pointing at the
host's own plugin directory. Plugin files are not part of the install tarball
or the npm package.

## Hook modes, migration and doctor

`crosshead install claude-code|codex` takes `--hook-mode auto|plugin|settings`
(default `auto`, or the explicit mode of the previous install, so
`crosshead update` repeats it). Plugin mode is chosen only when the plugin is
enabled at user scope, because the mode is global and the hooks it removes can
cover every project:

- Claude Code: `"enabledPlugins": {"crosshead@crosshead": true}` in the user
  settings (`settings.json` in the Claude config directory).
- Codex: `[plugins."crosshead@crosshead"]` (enabled unless `enabled = false`)
  in `$CODEX_HOME/config.toml`.

Only this repository's marketplace id, `crosshead@crosshead`, is recognized.
When the plugin is enabled only for a project (Claude Code project or local
settings, or a Codex project `.codex/config.toml`, which Codex applies only to
trusted projects), the mode stays `settings` and the installer hooks stay in
place; in that project the plugin defers to them. `--hook-mode plugin` in that
case writes no new installer hooks and removes none.

The mode is stored in the adapter configuration. In plugin mode the installer
removes the hooks it previously wrote (in the current workspace and the
previously configured one for Claude Code, and in `$CODEX_HOME/hooks.json` for
Codex). It keeps unrelated hooks, settings and top-level keys, and never deletes
a file: one left with nothing becomes `{}` (`{"hooks": {}}` for Codex). It
checks every file it would change before writing any, and refuses a symlinked
settings file without changing anything. Running it again changes nothing.

Codex runs plugin hooks only after the user trusts them in `/hooks`, again for
each changed version. So the Codex installer keeps its old hooks until the
runtime has seen a plugin invocation (recorded in
`state/host-plugin-invocations.json`); rerun `crosshead install codex` after the
first session with trusted hooks to remove them.

The hook entrypoint makes sure each event is handled once. "Installer hooks
loaded" means installer-written Crosshead hook commands (counted one by one;
empty arrays or groups never count) in exactly the files the host loads for the
session:

- Claude Code: the user settings, and `.claude/settings.json` and
  `.claude/settings.local.json` in the session's project directory
  (`CLAUDE_PROJECT_DIR`), plus `.claude/settings.local.json` at the git root.
  Ancestor directories are not checked, because Claude Code does not read them.
- Codex: `hooks.json` in the `CODEX_HOME` Codex ran with.

| Invocation | Installer hooks loaded | Recorded mode | Result |
| --- | --- | --- | --- |
| installer-written hook | yes | either | runs |
| plugin | yes | either | skipped |
| plugin | no | either | runs |
| installer-written hook | no (stale session) | `plugin` | skipped |
| installer-written hook | no | `settings` | runs |

`crosshead doctor` adds `claude_code_hooks` and `codex_hooks` checks for the
workspace (`--workspace-root`, else `CLAUDE_PROJECT_DIR`, else the current
directory). Each check reports the mode, where the plugin is enabled, and any
remaining installer-written hooks. The check fails for duplicate registrations,
for plugin mode with the plugin disabled or uninstalled, for settings mode with
no hooks for the workspace, and, for Codex, when the plugin is enabled but no
plugin invocation has been seen (it points to `/hooks` trust). It explains
project-only enablement instead of failing. Each failure names the fix.

Uninstalling the plugin removes its hooks. Doctor then reports that no Crosshead
hooks are active. Reinstall the plugin, or run
`crosshead install <host> --hook-mode settings` to go back to installer-written
hooks.

`SessionStart` matches `startup|resume|clear|compact` in both modes: `/clear`
starts a fresh context like `startup`. Installer-written hooks from earlier
versions keep their old matcher until the next install.

## Verification

```sh
npm ci && npm run release:build
npm run plugins:check
bash scripts/test-host-plugins.sh
```

The wrapper runs one disposable container (2 CPUs, 3 GiB RAM, no extra swap,
bounded tmpfs). It uses the pinned Node image with Claude Code `2.1.319` and
Codex `0.167.0`. `scripts/smoke-host-plugins.mjs` runs there as UID 1000 with
the repository read-only. A local fixture stands in for the Anthropic and
OpenAI APIs and serves this repository's installer
(`docs/security-review/install.sh`), with its digest pointed at the locally
built release. Hosted Crosshead calls go to an unreachable local address. The
real CLIs run headless sessions (`claude -p`, `codex exec`) that fire the
hooks. The check covers:

- `claude plugin validate --strict` and installation from the marketplace
  files.
- The setup line when no runtime is installed.
- Setup without host hooks.
- One capture per session with installer hooks, with installer hooks plus the
  plugin, and after migration.
- Doctor output in each of those states.
- No hooks left after the plugins are uninstalled.

It does not cover model-driven skill invocation or the Codex trust dialog (runs
use `--dangerously-bypass-hook-trust`); the unit tests cover the untrusted
window with direct hook invocations. It also does not cover identity
registration with the hosted service or native compaction: the compaction hooks
are driven with representative payloads.
