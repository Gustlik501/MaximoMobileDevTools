// Shared helpers: paths, logging, processes, config.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(TOOL_DIR, '..');

// Workspace layout. Everything except mdt/, patches/, targets/example.json and
// the docs is environment data and git-ignored.
export const P = {
  cfg: path.join(ROOT, 'mdt.json'),
  state: path.join(ROOT, '.mdt'),
  images: path.join(ROOT, 'images'),
  apps: path.join(ROOT, 'apps'),
  patches: path.join(ROOT, 'patches'),
  frameworkPatch: path.join(ROOT, 'patches', 'framework.patch'),
  targets: path.join(ROOT, 'targets'),
  dist: path.join(ROOT, 'dist'),
  framework: profile => path.join(ROOT, 'framework', profile),
  baseline: profile => path.join(ROOT, '.mdt', 'baseline', profile),
  out: (profile, appId) => path.join(ROOT, 'out', profile, appId),
  backups: appId => path.join(ROOT, '.mdt', 'backups', appId),
  tmp: path.join(ROOT, '.mdt', 'tmp')
};

export const APP_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;
export const DEFAULT_PACKAGES = ['maximo-js-api', 'react-components'];

// ---------------------------------------------------------------- logging

const tty = process.stdout.isTTY;
const paint = code => s => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), bold: paint(1)};
export const info = (...a) => console.log(c.dim('[mdt]'), ...a);
export const ok = (...a) => console.log(c.green('[mdt]'), ...a);
export const warn = (...a) => console.log(c.yellow('[mdt]'), ...a);

export class MdtError extends Error {}
export const fail = msg => {
  throw new MdtError(msg);
};

// ---------------------------------------------------------------- processes

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {stdio: 'inherit', ...opts});
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) fail(`${path.basename(cmd)} ${args.slice(0, 3).join(' ')} ... exited with ${r.status}`);
  return r;
}

export function capture(cmd, args, opts = {}) {
  const {binary, ...rest} = opts;
  const r = spawnSync(cmd, args, {encoding: binary ? undefined : 'utf8', maxBuffer: 1 << 30, ...rest});
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) {
    fail(`${path.basename(cmd)} ${args.slice(0, 4).join(' ')} failed (${r.status}): ${String(r.stderr || '').trim().slice(0, 500)}`);
  }
  return r;
}

// GNU tar from Git Bash cannot open C:\ paths; Windows ships bsdtar and curl.
const sys32 = exe => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
export const tarExe = () => (process.platform === 'win32' && fs.existsSync(sys32('tar.exe')) ? sys32('tar.exe') : 'tar');
export const curlExe = () => (process.platform === 'win32' && fs.existsSync(sys32('curl.exe')) ? sys32('curl.exe') : 'curl');

// ---------------------------------------------------------------- files

export const rel = p => path.relative(ROOT, p).split(path.sep).join('/') || '.';
export const abs = p => (path.isAbsolute(p) ? p : path.join(ROOT, p));
export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
export const sha256File = f => sha256(fs.readFileSync(f));

export function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function* walk(dir, r = '') {
  if (!fs.existsSync(path.join(dir, r))) return;
  for (const e of fs.readdirSync(path.join(dir, r), {withFileTypes: true})) {
    const x = r ? `${r}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(dir, x);
    else if (e.isFile()) yield x;
  }
}

export const readJson = (f, dflt = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return dflt;
  }
};

export async function confirm(question, expected) {
  if (!process.stdin.isTTY) fail(`${question}\n  (needs an interactive terminal, or pass --yes)`);
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  const ans = (await rl.question(`${question} `)).trim();
  rl.close();
  if (expected ? ans !== expected : !/^y(es)?$/i.test(ans)) fail('cancelled');
}

// ---------------------------------------------------------------- config (mdt.json)

export function loadCfg() {
  const cfg = readJson(P.cfg, {});
  cfg.activeProfile ??= null;
  cfg.profiles ??= {};
  cfg.apps ??= {};
  cfg.device ??= {};
  cfg.device.package ??= 'com.ibm.iot.maximo.mobile';
  cfg.container ??= {};
  cfg.buildEnv ??= {};
  return cfg;
}

export const saveCfg = cfg => fs.writeFileSync(P.cfg, `${JSON.stringify(cfg, null, 2)}\n`);

export function profileOf(cfg, opt = {}) {
  const name = opt.profile || cfg.activeProfile;
  if (!name) fail('no image profile yet: put a graphite-configuration .tar into images/ and run `mdt init`');
  const p = cfg.profiles[name];
  if (!p) fail(`unknown profile "${name}" (have: ${Object.keys(cfg.profiles).join(', ') || 'none'})`);
  return {name, ...p};
}

// app.xml root is <maximo-application> (most apps) or <application> (navigator).
// Attribute values can hold JS expressions, so scan to the '>' outside quotes.
export function readAppInfo(dir) {
  const xml = path.join(dir, 'src', 'app.xml');
  if (!fs.existsSync(xml)) return null;
  const head = fs.readFileSync(xml, 'utf8').slice(0, 50000);
  const m = head.match(/<(?:maximo-)?application\b/);
  if (!m) return null;
  let q = null;
  let end = head.length - 1;
  for (let i = m.index; i < head.length; i++) {
    const ch = head[i];
    if (q) {
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '>') {
      end = i;
      break;
    }
  }
  const tag = head.slice(m.index, end + 1);
  const attr = n => (tag.match(new RegExp(`\\s${n}="([^"]*)"`)) || [])[1];
  const pkg = readJson(path.join(dir, 'package.json'), {});
  return {
    id: attr('id'),
    version: attr('version'),
    title: attr('title'),
    masId: attr('mas-id') || null,
    platform: pkg.graphite?.platform || null
  };
}

export function appOf(cfg, idOrDir) {
  if (!idOrDir) fail(`which app? (have: ${Object.keys(cfg.apps).join(', ') || 'none'})`);
  const key = String(idOrDir).toLowerCase();
  if (cfg.apps[key]) return {id: key, ...cfg.apps[key]};
  for (const [id, a] of Object.entries(cfg.apps)) {
    if (path.basename(a.src).toLowerCase() === key) return {id, ...a};
  }
  fail(`unknown app "${idOrDir}" (have: ${Object.keys(cfg.apps).join(', ') || 'none'}; put it in apps/ and run mdt init)`);
}
