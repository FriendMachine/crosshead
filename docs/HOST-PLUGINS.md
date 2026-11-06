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
| `skills/setup/SKILL.md` | `/crosshead:setup` (Claude Code) or `crosshead:setup` (Codex) |
| `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` | Manifest |

The launcher finds the runtime home (`CROSSHEAD_HOME`, then `~/.crosshead`) and
runs the installed `crosshead-claude-code-hook` or `crosshead-codex-hook` with
`--via plugin`. These are the hook entrypoints the installer-written hooks use.
The launcher never downloads, installs or updates code. Without a configured
runtime, it prints one line on `SessionStart`, prints nothing for other events,
and exits 0:

```text
Crosshead isn't set up: run /crosshead:setup.
Crosshead isn't set up: ask Codex to use the crosshead setup skill ($crosshead:setup).
```

The line is a `systemMessage` the user sees, and context the agent sees. If the
runtime predates plugin support, the line asks you to run setup to update it,
and the plugin stays inactive, so older installer-written hooks keep working
without duplicates.

The setup skill explains what it is about to do, asks for consent, runs the
digest-checked installer, and then runs:

```sh
crosshead quickstart --api-base https://crosshead.sh --adapter claude-code --workspace-root . --hook-mode plugin
crosshead quickstart --api-base https://crosshead.sh --adapter codex --workspace-root . --hook-mode plugin
```

`--hook-mode plugin` writes the adapter configuration and wrappers but no host
hooks. Codex additionally requires you to trust the plugin hooks in `/hooks`;
a new plugin version needs a new review. The plugins have no MCP server.

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
installed plugins to their manifest version.

Claude Code reads `.claude-plugin/marketplace.json`. Codex reads
`.agents/plugins/marketplace.json` first and would otherwise fall back to the
Claude file. Both list one plugin, `crosshead@crosshead`, pointing at the
host's own plugin directory. Plugin files are not part of the install tarball
or the npm package.

## Hook modes, migration and doctor

`crosshead install claude-code|codex` takes `--hook-mode auto|plugin|settings`
(default `auto`). `auto` selects `plugin` when the host enables
`crosshead@<marketplace>`:

- Claude Code: `enabledPlugins` in `.claude/settings.local.json`,
  `.claude/settings.json` (workspace) or `~/.claude/settings.json`, in that
  order.
- Codex: `[plugins."crosshead@..."]` in `.codex/config.toml` or
  `$CODEX_HOME/config.toml`.

The mode is stored in the adapter configuration. In plugin mode the installer
removes the hooks it previously wrote (in the current workspace and the
previously configured one for Claude Code, and in `$CODEX_HOME/hooks.json` for
Codex). It keeps unrelated hooks and settings. It removes a file that held only
Crosshead hooks. Running it again changes nothing.

The hook entrypoint makes sure each event is handled once even before
migration:

| Recorded mode | Invocation | Result |
| --- | --- | --- |
| `plugin` | plugin | runs |
| `plugin` | installer-written hook | skipped |
| `settings` | installer-written hook | runs |
| `settings` | plugin, installer hooks cover this workspace | skipped |
| `settings` | plugin, no installer hooks here | runs |

`crosshead doctor` adds `claude_code_hooks` and `codex_hooks` checks. Each check
reports the mode, whether the plugin is enabled, and any remaining
installer-written hooks. The check fails for duplicate registrations, for plugin
mode with the plugin disabled or uninstalled, and for settings mode with no
hooks for the workspace. Each failure names the command that fixes it. Use
`--workspace-root` to inspect a different project.

Uninstalling the plugin removes its hooks. Doctor then reports that no Crosshead
hooks are active. Reinstall the plugin, or run
`crosshead install <host> --hook-mode settings` to go back to installer-written
hooks.

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
use `--dangerously-bypass-hook-trust`). It also does not cover identity
registration with the hosted service or native compaction: the compaction hooks
are driven with representative payloads.
