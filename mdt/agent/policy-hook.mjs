#!/usr/bin/env node
// Claude Code PreToolUse hook: applies the mdt-policy block from AGENTS.md /
// AGENTS.local.md to Edit/Write/Bash/PowerShell calls.
//   deny  -> the call is blocked, the agent sees the reason
//   ask   -> Claude Code asks the user, whatever the permission mode
//   allow -> no prompt (only for one plain mdt command or a direct file edit)
//   none  -> normal permission flow
// Registered in .claude/settings.json. Any internal error = no decision.
import {decideToolCall, loadPolicy} from '../lib/policy.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(raw || '{}');
    const input = {...(ev.tool_input || {}), cwd: ev.cwd};
    const r = decideToolCall(ev.tool_name || '', input, loadPolicy().policy);
    if (r) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: r.reason}
        })
      );
    }
  } catch {
    // never break the session because of the hook
  }
  process.exit(0);
});
