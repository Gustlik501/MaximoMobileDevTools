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
  framework: ['read-only', 'ask', 'auto'], // edits under Framework/CUSTOMIZED
  apps: ['read-only', 'ask', 'auto'], // edits under MobileApps/CUSTOMIZED
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
  publish: 'upload',
  ootb: 'ootb-write',
  upgrade: 'upgrade'
};

/** Category of one mdt invocation: args = everything after `mdt`. */
export function classifyMdt(args) {
  const [sub, sub2] = args;
  const dry = args.includes('--dry-run');
  if (sub === 'policy' && sub2 === 'set') return 'policy-change';
  if (sub === 'app' && sub2 === 'import') return 'device-read';
  if (sub === 'env' && sub2 === 'detect') return 'device-read';
  if (sub === 'upgrade' && dry) return null;
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
    case 'ootb-write':
      return {key: 'ootb', level: 'pristine', decision: 'ask'};
    case 'upgrade': {
      // writes Framework/CUSTOMIZED and MobileApps/CUSTOMIZED
      const f = decide(policy, 'framework-write');
      const a = decide(policy, 'apps-write');
      return RANK[f.decision] >= RANK[a.decision] ? f : a;
    }
    case 'adb-risky':
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

/** every category a path touches: the file, a protected folder itself, or a parent of one */
export function classifyPathAll(file, cwd = ROOT) {
  if (!file || typeof file !== 'string') return [];
  file = file.replace(/^\/([a-z])\//i, '$1:/'); // Git Bash /c/Users -> c:/Users
  const p = norm(path.isAbsolute(file) ? file : path.join(cwd, file)).replace(/\/+$/, '');
  if (PROTECTED.includes(p)) return ['policy-change'];
  const within = base => p === `${ROOT_N}/${base}` || p.startsWith(`${ROOT_N}/${base}/`);
  if (within('framework/ootb') || p === `${ROOT_N}/framework/ootb.json` || within('mobileapps/ootb')) return ['ootb-write'];
  if (within('framework/customized')) return ['framework-write'];
  if (within('mobileapps/customized')) return ['apps-write'];
  if (p === `${ROOT_N}/framework`) return ['ootb-write', 'framework-write'];
  if (p === `${ROOT_N}/mobileapps`) return ['ootb-write', 'apps-write'];
  return [];
}

export function classifyPath(file, cwd = ROOT) {
  return classifyPathAll(file, cwd)[0] || null;
}

// ---------------------------------------------------------------- shell commands
// Only real writes count: reading (cat, grep, diff, ls, Get-Content, ...) is never
// gated, whatever the policy. A path is "written" when it is a redirect target or
// an argument of a command that writes (for copies: the destination only).

/** Split a command line into segments of tokens. Quotes are respected; `>`/`>>` become {redirect} markers. */
export function parseShell(cmd) {
  const segs = [];
  let tokens = [];
  let cur = '';
  let has = false;
  let q = null;
  const push = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  const end = () => {
    push();
    if (tokens.length) segs.push(tokens);
    tokens = [];
  };
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (ch === '\n' || ch === ';') end();
    else if (/\s/.test(ch)) push();
    else if (ch === '&' && s[i + 1] === '&') {
      end();
      i++;
    } else if (ch === '|') {
      if (s[i + 1] === '|') i++;
      end();
    } else if (ch === '>') {
      if (/^(\d+|&|\*)$/.test(cur)) {
        cur = ''; // 2> &> *>
        has = false;
      } else push();
      if (s[i + 1] === '>') i++;
      if (s[i + 1] === '&') {
        i++; // 2>&1, >&2: duplicates a stream, writes no file
        while (/[\d-]/.test(s[i + 1] || '')) i++;
      } else tokens.push({redirect: true});
    } else if (ch === '<') push();
    else {
      cur += ch;
      has = true;
    }
  }
  end();
  return segs;
}

const NULL_TARGETS = /^(\/dev\/null|\$null|nul|null)$/i;
const PREFIXES = new Set(['sudo', 'command', 'time', 'nohup', 'env', 'exec', '&', 'call', 'start']);
const CD = new Set(['cd', 'pushd', 'set-location', 'sl', 'chdir']);
const WRITES_ALL_ARGS = new Set([
  'rm', 'rmdir', 'mkdir', 'touch', 'truncate', 'chmod', 'chown', 'tee', 'patch', 'del', 'erase', 'rd', 'md', 'unlink', 'shred',
  'mv', 'move', 'ren', 'rename', 'remove-item', 'ri', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac', 'clear-content',
  'clc', 'out-file', 'move-item', 'mi', 'rename-item', 'rni'
]);
const WRITES_DEST = new Set(['cp', 'copy', 'copy-item', 'cpi', 'install', 'rsync', 'ln', 'xcopy', 'robocopy', 'scp']);
const GIT_WRITES = new Set(['apply', 'checkout', 'restore', 'rm', 'mv', 'clean', 'stash', 'reset', 'am', 'merge', 'pull', 'cherry-pick', 'revert', 'rebase', 'switch']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh']);
const SCRIPTS = new Set(['node', 'python', 'python3', 'py', 'perl', 'ruby', 'deno', 'bun']);
const SCRIPT_WRITE = /writeFile|appendFile|rmSync|rmdirSync|unlinkSync|renameSync|cpSync|copyFileSync|mkdirSync|createWriteStream|open\([^)]*['"][wax+]|write_text|write_bytes|shutil\.|os\.(remove|rename|unlink|makedirs)|Set-Content|Out-File|Remove-Item|Copy-Item|Move-Item/;

// Raw adb is classified like the mdt command that does the same thing, so it follows
// `device` / `device-ui`. Commands that can lose data (AGENTS.md "Never": uninstall,
// clear app data, delete files, change settings) always ask.
const ADB_READ = /^(devices|version|get-state|get-serialno|logcat\s+-d|forward\s+--list|exec-out\s+screencap|shell\s+(getprop|dumpsys|pm\s+list|pidof|cat\s+\/proc|wm\s+size|ps))\b/i;
const ADB_UI = /^shell\s+input\s/i;
const ADB_RISKY =
  /^(uninstall|reboot|root|unroot|remount|disable-verity|enable-verity|sideload|(shell|exec-out)\s+(.*[\s;&|'"])?(pm\s+(clear|uninstall|disable|reset-permissions)|cmd\s+package\s+(clear|uninstall)|rm|rmdir|mv|settings\s+(put|delete|reset)|svc|reboot|wipe)\b)/i;
// commands that only filter the output of a device command
const READ_FILTERS = new Set([
  'grep', 'egrep', 'fgrep', 'head', 'tail', 'sort', 'uniq', 'wc', 'cut', 'tr', 'findstr', 'select-string', 'sls', 'select-object',
  'select', 'where-object', 'out-string', 'measure-object', 'format-table', 'ft', 'format-list', 'fl'
]);

/** Category of one raw adb call: args = everything after `adb`. */
export function classifyAdb(args) {
  const a = [...args];
  // global options: -s/-t/-H/-P/-L take a value; -d/-e/-a don't
  while (a.length && /^-[a-zA-Z]$/.test(a[0])) a.splice(0, /^-[stHPL]$/.test(a[0]) ? 2 : 1);
  const rest = a.join(' ');
  if (ADB_RISKY.test(rest)) return 'adb-risky';
  if (ADB_READ.test(rest) && !/[;&|`$<>]/.test(rest)) return 'device-read';
  if (ADB_UI.test(rest)) return 'device-ui';
  return 'device-write';
}

const cmdName = t => path.basename(String(t).replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
const isStr = t => typeof t === 'string';

/** {cmd, args, redirects} of one segment (leading env assignments and sudo-like prefixes skipped). */
function commandOf(tokens) {
  const redirects = [];
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isStr(tokens[i])) {
      if (isStr(tokens[i + 1])) redirects.push(tokens[++i]);
      continue;
    }
    words.push(tokens[i]);
  }
  let k = 0;
  while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]) || PREFIXES.has(cmdName(words[k])))) k++;
  return {cmd: words[k] ? cmdName(words[k]) : '', raw: words[k] || '', args: words.slice(k + 1), redirects};
}

/** Paths a segment writes to (null = it writes, but the targets are unknown, e.g. via xargs). */
function writtenPaths({cmd, args}) {
  const pos = args.filter(a => !a.startsWith('-'));
  if (cmd === 'xargs') {
    // targets come from stdin: unknown
    const inner = cmdName(args.find(a => !a.startsWith('-')) || '');
    const writes = WRITES_ALL_ARGS.has(inner) || WRITES_DEST.has(inner) || ((inner === 'sed' || inner === 'perl') && args.some(a => /^-[a-z]*i/i.test(a)));
    return writes ? null : [];
  }
  if (WRITES_ALL_ARGS.has(cmd)) return pos;
  if (WRITES_DEST.has(cmd)) return pos.slice(-1);
  if ((cmd === 'sed' || cmd === 'perl') && args.some(a => /^-[a-z]*i/i.test(a) || a === '--in-place')) return pos;
  if (cmd === 'git' && GIT_WRITES.has(args.find(a => !a.startsWith('-')))) return pos.slice(1);
  if (cmd === 'find' && args.some(a => a === '-delete' || a === '-exec' || a === '-execdir')) {
    const execAt = args.findIndex(a => a === '-exec' || a === '-execdir');
    const writes = args.includes('-delete') || (execAt >= 0 && (WRITES_ALL_ARGS.has(cmdName(args[execAt + 1])) || WRITES_DEST.has(cmdName(args[execAt + 1])) || cmdName(args[execAt + 1]) === 'sed'));
    return writes ? args.slice(0, args.findIndex(a => a.startsWith('-')) < 0 ? args.length : args.findIndex(a => a.startsWith('-'))) : [];
  }
  if (cmd === 'tar' && args.some(a => /^-?[a-z]*x/.test(a) || a === '--extract')) {
    const c = args.findIndex(a => a === '-C' || a === '--directory');
    return [c >= 0 ? args[c + 1] : '.'];
  }
  if (cmd === 'unzip' || cmd === 'expand-archive') {
    const d = args.findIndex(a => a === '-d' || /^-destinationpath$/i.test(a));
    return [d >= 0 ? args[d + 1] : '.'];
  }
  if (cmd === 'curl' || cmd === 'wget' || cmd === 'invoke-webrequest' || cmd === 'iwr') {
    const o = args.findIndex(a => a === '-o' || a === '-O' || a === '--output' || /^-outfile$/i.test(a));
    return o >= 0 ? [args[o + 1]] : [];
  }
  if (cmd === 'dd') return args.filter(a => a.startsWith('of=')).map(a => a.slice(3));
  return [];
}

function mdtArgsOf({cmd, args}) {
  if (cmd === 'mdt' || cmd === 'mdt.cmd' || cmd === 'mdt.sh') return args;
  if (cmd === 'node' && args[0] && /mdt\.mjs$/i.test(args[0])) return args.slice(1);
  return null;
}

/** Categories found in a shell command, plus whether it is one simple mdt call. */
export function classifyCommand(cmdline, cwd = ROOT, depth = 0) {
  const classes = new Set();
  const text = String(cmdline);
  // command substitutions run too: classify them as well
  const subs = [...text.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map(m => m[1] ?? m[2]);
  const segs = parseShell(text);
  let dir = cwd;
  const addPath = p => {
    for (const c of classifyPathAll(p, dir)) classes.add(c);
  };
  for (const tokens of segs) {
    const seg = commandOf(tokens);
    for (const r of seg.redirects) if (!NULL_TARGETS.test(r)) addPath(r);
    if (!seg.cmd) continue;
    if (CD.has(seg.cmd)) {
      const to = seg.args.find(a => !a.startsWith('-'));
      if (to) dir = path.resolve(dir, to);
      continue;
    }
    const margs = mdtArgsOf(seg);
    if (margs) {
      const cls = classifyMdt(margs);
      if (cls) classes.add(cls);
      continue;
    }
    if (seg.cmd === 'adb') {
      classes.add(classifyAdb(seg.args));
      continue;
    }
    if (['podman', 'docker', 'skopeo'].includes(seg.cmd) && ['push', 'copy'].includes(seg.args.find(a => !a.startsWith('-')))) {
      classes.add('registry-push');
      continue;
    }
    if (SHELLS.has(seg.cmd) && depth < 3) {
      const ci = seg.args.findIndex(a => /^(-c|\/c|-command|-c[a-z]*)$/i.test(a));
      if (ci >= 0 && seg.args[ci + 1]) for (const c of classifyCommand(seg.args.slice(ci + 1).join(' '), dir, depth + 1).classes) classes.add(c);
      continue;
    }
    if (SCRIPTS.has(seg.cmd)) {
      // inline scripts: count as a write only if they use a write API on a protected path
      if (seg.args.some(a => SCRIPT_WRITE.test(a))) for (const a of seg.args) for (const m of a.match(/[\w./\\:-]+/g) || []) addPath(m);
      continue;
    }
    const w = writtenPaths(seg);
    if (w === null) for (const t of segs.flat().filter(isStr)) addPath(t);
    else for (const p of w) if (p) addPath(p);
  }
  for (const s of subs) if (depth < 3) for (const c of classifyCommand(s, dir, depth + 1).classes) classes.add(c);
  // simple: mdt/adb calls, cd, and filters of their output; no file redirects, no $(...)
  const parsed = segs.map(commandOf);
  const isDeviceCall = s => !!mdtArgsOf(s) || s.cmd === 'adb';
  const simple =
    !subs.length &&
    parsed.some(isDeviceCall) &&
    parsed.every(s => (isDeviceCall(s) || CD.has(s.cmd) || READ_FILTERS.has(s.cmd)) && s.redirects.every(r => NULL_TARGETS.test(r)));
  return {classes: [...classes], simple};
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
    const r = classifyCommand(input.command || '', input.cwd || ROOT);
    classes = r.classes;
    simple = r.simple;
  }
  if (!classes.length) return null;
  let best = null;
  for (const cls of classes) {
    const d = decide(policy, cls);
    if (!d.decision) continue;
    if (!best || RANK[d.decision] > RANK[best.decision]) best = {...d, cls};
  }
  if (!best) return null;
  // only plain mdt/adb calls (or a direct file edit) may be auto-allowed
  if (best.decision === 'allow' && !simple) return null;
  const what = {
    'device-read': 'reading from the device',
    'device-write': 'installing/reloading on the device',
    'device-ui': 'driving the app UI on the device',
    'adb-risky': 'a raw adb command that can lose device data (uninstall, pm clear, rm, settings, reboot)',
    'framework-write': 'changing framework sources (Framework/CUSTOMIZED)',
    'apps-write': 'changing app sources (MobileApps/CUSTOMIZED)',
    'ootb-write': "changing IBM's pristine sources (OOTB: only via mdt ootb during an upgrade)",
    upgrade: 'merging a new IBM release into CUSTOMIZED',
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
