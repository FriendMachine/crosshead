// Tests must never reach the developer's real Crosshead runtime, Claude Code or Codex configuration.
// An agent session running the suite exports these (for example CLAUDE_CONFIG_DIR=~/.claude and
// CROSSHEAD_HOME=~/.crosshead); a spawned hook or bridge that inherits them writes into the real daemon.
// Tests that need one of these set it explicitly for the process they start.
const INHERITED_HOST_VARIABLES = [
	"CROSSHEAD_HOME",
	"CROSSHEAD_RUNTIME_HOME",
	"CROSSHEAD_PROFILE",
	"ONLYBOTS_HOME",
	"ONLYBOTS_RUNTIME_HOME",
	"ONLYBOTS_PROFILE",
	"ONLYBOTS_CLAUDE_WRAPPER_ACTIVE",
	"CLAUDE_CONFIG_DIR",
	"CLAUDE_CODE_HOME",
	"CODEX_HOME",
];

for (const name of INHERITED_HOST_VARIABLES) delete process.env[name];
