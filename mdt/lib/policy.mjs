// Agent permission policy.
//
// The policy lives in a fenced ```mdt-policy block in AGENTS.md (defaults,
// committed) and optionally AGENTS.local.md (this clone only, git-ignored,
// wins). It is enforced in two places:
//   - mdt/agent/policy-hook.mjs: Claude Code PreToolUse hook (allow/ask/deny per tool call)
//   - mdt itself: refuses blocked actions when run non-interactively (any agent)
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from './util.mjs';

export const POLICY_FILES = [path.join(ROOT, 'AGENTS.md'), path.join(ROOT, 'AGENTS.local.md')];

export const LEVELS = {
  device: ['off', 'read-only', 'ask', 'auto'], // install/reload/restart on the device
  'device-ui': ['off', 'read-only', 'ask', 'auto'], // driving the app: tap, type, key, eval
  'device-data': ['ask', 'auto'], // saving/submitting/syncing records while driving (agent behavior)
  framework: ['read-only', 'ask', 'auto'], // edits under framework/
  apps: ['read-only', 'ask', 'auto'], // edits under apps/
  uploads: ['never', 'ask'] // mdt upload/publish, registry pushes
};

export const DEFAULTS = {device: 'ask', 'device-ui': 'ask', 'device-data': 'ask', framework: 'ask', apps: 'auto', uploads: 'ask'};

export function parseBlock(text) {
  const m = String(text).match(/```mdt-policy\s*\n([\s\S]*?)```/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const l = line.replace(/#.*/, '').trim();
    const kv = l.match(/^([a-z-]+)\s*:\s*([a-z-]+)$/);
    if (kv && LEVELS[kv[1]] && LEVELS[kv[1]].includes(kv[2])) out[kv[1]] = kv[2];
  }
  return out;
}

export function loadPolicy() {
  const policy = {...DEFAULTS};
  const sources = {};
  for (const k of Object.keys(policy)) sources[k] = 'default';
  for (const f of POLICY_FILES) {
    if (!fs.existsSync(f)) continue;
    const b = parseBlock(fs.readFileSync(f, 'utf8')) || {};
    for (const [k, v] of Object.entries(b)) {
      policy[k] = v;
      sources[k] = path.basename(f);
    }
  }
  const cap = policy.device === 'off' ? 'off' : policy.device === 'read-only' && ['ask', 'auto'].includes(policy['device-ui']) ? 'read-only' : null;
  if (cap && policy['device-ui'] !== cap) {
    policy['device-ui'] = cap;
    sources['device-ui'] = `capped by device: ${policy.device}`;
  }
  return {policy, sources};
}

export function writeLocalPolicy(changes) {
  const file = POLICY_FILES[1];
  const current = fs.existsSync(file) ? parseBlock(fs.readFileSync(file, 'utf8')) || {} : {};
  const next = {...current, ...changes};
  const body = Object.entries(next)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(
    file,
    `# Agent policy for this clone (overrides AGENTS.md, git-ignored)\n\nChange with \`mdt policy set key=value\` in your own terminal, or edit here.\n\n\`\`\`mdt-policy\n${body}\n\`\`\`\n`
  );
  return next;
}

// ---------------------------------------------------------------- classification

// mdt subcommand -> category
const MDT_CLASSES = {
  device: 'device-read',
  backup: 'device-read',
  screenshot: 'device-read',
  ui: 'device-read',
  wait: 'device-read',
  scroll: 'device-read',
  state: 'device-read',
  console: 'device-read',
  logcat: 'device-read',
  push: 'device-write',
  deploy: 'device-write',
  restore: 'device-write',
  reload: 'device-write',
  tap: 'device-ui',
  type: 'device-ui',
  key: 'device-ui',
  eval: 'device-ui',
  upload: 'upload',
  publish: 'upload'
};

/** Category of one mdt invocation: args = everything after `mdt`. */
export function classifyMdt(args) {
  const [sub, sub2] = args;
  const dry = args.includes('--dry-run');
  if (sub === 'policy' && sub2 === 'set') return 'policy-change';
  if (sub === 'app' && sub2 === 'import') return 'device-read';
  if (sub === 'env' && sub2 === 'detect') return 'device-read';
  if ((sub === 'framework' || sub === 'fw') && ['load', 'reset', 'apply', 'extract'].includes(sub2)) return 'framework-write';
  if (sub === 'console' && args.includes('--reload')) return 'device-write';
  const cls = MDT_CLASSES[sub];
  if (!cls) return null;
  if (dry && (cls === 'device-write' || cls === 'upload')) return cls === 'upload' ? null : 'device-read';
  return cls;
}

/** What the policy says about a category: {level, decision: allow|ask|deny|null, reason} */
export function decide(policy, cls) {
  const how = (key, map) => {
    const level = policy[key];
    const decision = map[level];
    return {key, level, decision};
  };
  switch (cls) {
    case 'device-read':
      return how('device', {off: 'deny', 'read-only': 'allow', ask: 'allow', auto: 'allow'});
    case 'device-write':
      return how('device', {off: 'deny', 'read-only': 'deny', ask: 'ask', auto: 'allow'});
    case 'device-ui':
      return how('device-ui', {off: 'deny', 'read-only': 'deny', ask: 'ask', auto: 'allow'});
    case 'framework-write':
      return how('framework', {'read-only': 'deny', ask: 'ask', auto: 'allow'});
    case 'apps-write':
      return how('apps', {'read-only': 'deny', ask: 'ask', auto: 'allow'});
    case 'upload':
      return how('uploads', {never: 'deny', ask: 'ask'});
    case 'policy-change':
      return {key: 'policy', level: 'user-only', decision: 'ask'};
    case 'adb-write':
      return how('device', {off: 'deny', 'read-only': 'deny', ask: 'ask', auto: 'ask'});
    case 'registry-push':
      return how('uploads', {never: 'deny', ask: 'ask'});
    default:
      return {decision: null};
  }
}

// ---------------------------------------------------------------- tool calls (hook)

const norm = p => path.resolve(p).replace(/\\/g, '/').toLowerCase();
const ROOT_N = norm(ROOT);
const PROTECTED = ['AGENTS.md', 'AGENTS.local.md', '.claude/settings.json', '.claude/settings.local.json', 'mdt/agent/policy-hook.mjs', 'mdt/lib/policy.mjs'].map(
  f => `${ROOT_N}/${f.toLowerCase()}`
);

export function classifyPath(file, cwd = ROOT) {
  if (!file) return null;
  const p = norm(path.isAbsolute(file) ? file : path.join(cwd, file));
  if (PROTECTED.includes(p)) return 'policy-change';
  if (p.startsWith(`${ROOT_N}/framework/`)) return 'framework-write';
  if (p.startsWith(`${ROOT_N}/apps/`)) return 'apps-write';
  return null;
}

// split a shell command line into simple segments
const splitSegments = cmd => String(cmd).split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(Boolean);
const SHELL_META = /[;&|`<>\n]|\$\(/;

const WRITE_VERB =
  /(^|[\s(])(sed\s+(-[a-z]*i|--in-place)|perl\s+-[a-z]*i|tee|cp|mv|rm|rmdir|mkdir|touch|truncate|install|ln|unzip|tar\s+-?[a-z]*x|git\s+(apply|checkout|restore|stash|reset|clean|am|mv|rm)|patch|set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|rename-item|clear-content|del|erase|copy|move|ren|writefile\w*|appendfile\w*|rmsync|unlinksync)\b|>/i;

const ADB_READ = /\badb(\.exe)?["']?\s+(-s\s+\S+\s+)?(devices|version|get-state|get-serialno|logcat\s+-d|forward\s+--list|exec-out\s+screencap|shell\s+(getprop|dumpsys|pm\s+list|pidof|cat\s+\/proc|wm\s+size|ps))/i;

function mdtArgs(segment) {
  const m = segment.match(/(?:^|[\s"'\\/])(?:mdt(?:\.cmd|\.sh)?|mdt\.mjs)["']?\s+(.*)$/i);
  if (!m) return null;
  return m[1].split(/\s+/).filter(Boolean).map(a => a.replace(/^["']|["']$/g, ''));
}

/** Categories found in a shell command, plus whether it is one simple mdt call. */
export function classifyCommand(cmd) {
  const classes = new Set();
  const segs = splitSegments(cmd);
  for (const seg of segs) {
    const args = mdtArgs(seg);
    if (args) {
      const cls = classifyMdt(args);
      if (cls) classes.add(cls);
      continue;
    }
    if (/\badb(\.exe)?["']?\s/i.test(seg) && !ADB_READ.test(seg)) classes.add('adb-write');
    if (/\b(podman|docker|skopeo)(\.exe)?\s+(push|copy)\b/i.test(seg)) classes.add('registry-push');
    if (WRITE_VERB.test(seg)) {
      const s = seg.replace(/\\/g, '/').toLowerCase();
      if (/(^|[\s"'/=])framework\//.test(s) && !/\bmdt(\.cmd|\.sh)?\s+framework\b/.test(s)) classes.add('framework-write');
      if (/(^|[\s"'/=])apps\//.test(s)) classes.add('apps-write');
      if (/agents(\.local)?\.md|\.claude\/settings|policy-hook\.mjs|lib\/policy\.mjs/.test(s)) classes.add('policy-change');
    }
  }
  const simpleMdt = segs.length === 1 && !!mdtArgs(segs[0]) && !SHELL_META.test(String(cmd));
  return {classes: [...classes], simpleMdt};
}

const RANK = {deny: 3, ask: 2, allow: 1};
const advice = 'The user decides this in AGENTS.local.md (`mdt policy set ...` in their own terminal).';

/** Combined decision for a Claude Code tool call. */
export function decideToolCall(toolName, input, policy) {
  let classes = [];
  let simple = false;
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName)) {
    const c = classifyPath(input.file_path || input.notebook_path || input.path, input.cwd);
    if (c) classes = [c];
    simple = true;
  } else if (/^(Bash|PowerShell)$/.test(toolName)) {
    const r = classifyCommand(input.command || '');
    classes = r.classes;
    simple = r.simpleMdt;
  }
  if (!classes.length) return null;
  let best = null;
  for (const cls of classes) {
    const d = decide(policy, cls);
    if (!d.decision) continue;
    if (!best || RANK[d.decision] > RANK[best.decision]) best = {...d, cls};
  }
  if (!best) return null;
  // only a single plain mdt call (or a direct file edit) may be auto-allowed
  if (best.decision === 'allow' && !simple) return null;
  const what = {
    'device-read': 'reading from the device',
    'device-write': 'installing/reloading on the device',
    'device-ui': 'driving the app UI on the device',
    'adb-write': 'a raw adb command that may change the device (use mdt instead)',
    'framework-write': 'changing framework sources (framework/)',
    'apps-write': 'changing app sources (apps/)',
    upload: 'uploading to a Maximo server',
    'registry-push': 'pushing an image to a registry',
    'policy-change': "changing the agent policy or its enforcement (user's call)"
  }[best.cls];
  const reason =
    best.decision === 'deny'
      ? `mdt policy: ${what} is blocked (${best.key}: ${best.level}). ${advice}`
      : best.decision === 'ask'
        ? `mdt policy: ${what} needs your approval (${best.key}: ${best.level}).`
        : `mdt policy: ${what} allowed (${best.key}: ${best.level}).`;
  return {decision: best.decision, reason, cls: best.cls};
}
