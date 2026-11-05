import type { NativeHostConfig } from "./native-host-adapter";

/** Python has no additional dependencies; all daemon access stays in the client. */
export const renderHermesPlugin = (config: NativeHostConfig, node: string, hook: string): string => `# crosshead-native-host-v1
import json
import logging
import os
import subprocess
import threading
import uuid

_COMMAND = json.loads(${JSON.stringify(JSON.stringify([node, hook, "--host", "hermes", "--home", config.runtimeHome]))})
_pending = {}
_reported_failures = set()
_lock = threading.RLock()
_warning = "Crosshead continuity is unavailable for this turn. Run crosshead doctor; do not assume saved memory was loaded or this turn was captured."

def _text(value):
    if isinstance(value, str):
        return value[:16384]
    if isinstance(value, list):
        return "\\n".join(p.get("text", "") for p in value if isinstance(p, dict) and p.get("type") == "text")[:16384]
    return ""

def _send(event, turn):
    try:
        result = subprocess.run(_COMMAND, input=json.dumps(dict(turn, event=event)), text=True,
                                capture_output=True, timeout=15, check=False)
        value = json.loads(result.stdout)
        if result.returncode or not value.get("ok"):
            raise RuntimeError("delivery failed")
        return value
    except Exception:
        logging.getLogger(__name__).warning("Crosshead lifecycle delivery unavailable; run crosshead doctor")
        return {"ok": False, "contextText": _warning}

def _prepare(session_id, user_message, workspace_root, **kwargs):
    if not workspace_root or not os.path.isabs(workspace_root):
        return {"context": _warning}
    turn_id = kwargs.get("turn_id")
    turn = {"sessionId": session_id, "turnId": str(turn_id) if turn_id is not None and str(turn_id) else str(uuid.uuid4()),
            "workspaceRoot": os.path.abspath(workspace_root),
            "prompt": _text(user_message)[:8192]}
    result = _send("prepare", turn)
    turn["packId"] = result.get("packId")
    with _lock:
        if len(_pending) >= 512:
            expired = next(iter(_pending))
            _pending.pop(expired)
            _reported_failures.discard(expired)
        _pending[(session_id, turn["turnId"])] = turn
    return {"context": result.get("contextText", "")}

def _complete(session_id, assistant_response, **kwargs):
    with _lock:
        turn_id = kwargs.get("turn_id")
        key = (session_id, str(turn_id) if turn_id is not None else "")
        if key not in _pending and turn_id is None:
            keys = [k for k in _pending if k[0] == session_id]
            if len(keys) != 1:
                return
            key = keys[0]
        turn = _pending.pop(key, None)
        _reported_failures.discard(key)
    if turn:
        turn["summary"] = _text(assistant_response)
        _send("complete", turn)

def _end(session_id, **kwargs):
    # Canonical turn finalization runs for failures and interruptions as well as
    # success. Reduced process-teardown notifications cannot identify a turn.
    turn_id = kwargs.get("turn_id")
    if turn_id is None or not str(turn_id):
        return
    if not (kwargs.get("failed") is True or kwargs.get("interrupted") is True or kwargs.get("completed") is False):
        return
    with _lock:
        key = (session_id, str(turn_id))
        turn = _pending.pop(key, None)
        reported = key in _reported_failures
        _reported_failures.discard(key)
    if turn and not reported:
        turn["summary"] = "Hermes turn failed or was interrupted; completion was not confirmed."
        _send("failed", turn)

def _api_error(session_id, **kwargs):
    # Hermes v0.22.7 returns early for some fatal API errors, bypassing
    # on_session_end. Ignore transient attempts; retain the pending turn so a
    # later successful recovery can replace this unconfirmed failure.
    count, maximum = kwargs.get("retry_count"), kwargs.get("max_retries")
    exhausted = isinstance(count, int) and isinstance(maximum, int) and count >= maximum
    if kwargs.get("retryable") is not False and not exhausted:
        return
    turn_id = kwargs.get("turn_id")
    if turn_id is None or not str(turn_id):
        return
    key = (session_id, str(turn_id))
    with _lock:
        turn = _pending.get(key)
        if not turn or key in _reported_failures:
            return
        _reported_failures.add(key)
    if turn:
        result = _send("failed", dict(turn, summary="Hermes turn failed or was interrupted; completion was not confirmed."))
        if not result.get("ok"):
            with _lock:
                _reported_failures.discard(key)

def register(ctx):
    # The gateway's cwd/environment is shared by unrelated sessions. Hermes's
    # plugin context resolves the calling session's workspace instead.
    def prepare(session_id, user_message, **kwargs):
        return _prepare(session_id, user_message, ctx.session_cwd(), **kwargs)
    ctx.register_hook("pre_llm_call", prepare)
    ctx.register_hook("post_llm_call", _complete)
    ctx.register_hook("on_session_end", _end)
    ctx.register_hook("api_request_error", _api_error)
`;
