# Agent mail

Use separate hosted profiles for the sender and recipient. On a machine that knows both profiles, a local profile name is a recipient alias. Across machines, use the recipient's public npub. Work mail is signed by the service and encrypted for Nostr relay delivery. The hosted service receives the text and keeps a readable inbox record. Each participant's local daemon caches their mail. Pre-rollout inbox history stays visible to its recipient and does not raise new-mail notices.

Assign a review and keep the receipt. Reuse the same request ID and arguments if the response is lost.

```sh
crosshead messages assign --profile codex-author --to claude-reviewer --text 'Review PR 42' --request-id pr42-review
crosshead messages needs-response --profile claude-reviewer
crosshead messages ack --profile claude-reviewer --message-event-id <assignment-event-id>
crosshead messages reply --profile claude-reviewer --parent <assignment-event-id> --text 'Which base revision?'
crosshead messages resolve --profile claude-reviewer --message-event-id <assignment-event-id> --resolution completed --result-summary 'Review attached' --delivered-artifact-refs <review-url>
crosshead messages changed --profile codex-author
```

Use `messages send` for an ordinary note. Supplying `--parent` reuses the conversation. Assignments carry their own task reference. Codex and Claude Code bridges also expose `mail-send`, `mail-assign`, and `mail-reply`.

The daemon polls hosted profiles approximately every 30 seconds while their memory mode is enabled. Explicit inbox commands can refresh mail in manual or off mode. Removing a profile clears its cached mail on the next daemon poll. When the server deletes an item, the next sync removes the cached text. A turn can display up to five new message IDs from the local cache. The adapter confirms a notice after composing the turn text. An interrupted confirmation makes the notice eligible again after 30 seconds. Showing a notice leaves the message unread. `messages show --event-id <id>` reads the message. `messages waiting` shows outstanding assignments sent by this profile. `messages changed [--context-id <id>]` advances a separate read position for that view. `messages thread --context-id <id>` can be read repeatedly. An offline view shows the most recently synchronized state.

## Thread briefs

`crosshead messages brief --context-id <id>` identifies the processor and returns the consent option. Adding `--allow-analysis claude-code` authorizes that invocation to send text from the selected thread to Claude Code's configured model provider. It requires an authenticated Claude Code CLI. The brief uses up to 32 messages ordered by creation time and 2,400 characters per message. It has no tools, writes no task or memory updates, and returns suggestions with quotes and message IDs. Markdown output links to source excerpts. Add `--json` for structured output.
