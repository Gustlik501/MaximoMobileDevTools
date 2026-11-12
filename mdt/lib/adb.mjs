// adb for mdt. Order: mdt.json device.adb (explicit) > mdt/platform-tools/<os>/
// (Google's platform-tools, `mdt adb update`) > an installed adb (PATH, a running
// server, the Android SDK).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {P, TOOL_DIR, curlExe, fail, info, ok, rel, tarExe, warn} from './util.mjs';

const REPO = 'https://dl.google.com/android/repository/';
const INDEX = `${REPO}repository2-3.xml`; // the index Android Studio's SDK manager reads
const CHANNELS = {stable: 0, beta: 1, dev: 2, canary: 3};
export const OSES = ['windows', 'linux', 'macosx'];
export const HOST_OS = {win32: 'windows', linux: 'linux', darwin: 'macosx'}[process.platform] || null;
export const BUNDLE = path.join(TOOL_DIR, 'platform-tools');
// what adb needs from the archive (on Windows, the two USB DLLs next to adb.exe), plus version + licenses
const KEEP = {windows: ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'], linux: ['adb'], macosx: ['adb']};
const META = ['source.properties', 'NOTICE.txt'];

const exe = os => path.join(BUNDLE, os, os === 'windows' ? 'adb.exe' : 'adb');

export function bundledAdb() {
  const f = HOST_OS && exe(HOST_OS);
  if (!f || !fs.existsSync(f)) return null;
  if (HOST_OS !== 'windows') {
    // a clone made on Windows has no executable bit
    try {
      fs.accessSync(f, fs.constants.X_OK);
    } catch {
      fs.chmodSync(f, 0o755);
    }
  }
  return f;
}

export function detectAdb() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['adb'], {encoding: 'utf8'});
  if (which.status === 0) return which.stdout.split(/\r?\n/)[0].trim();
  if (process.platform === 'win32') {
    // the adb server is often already running from scrcpy or Android Studio
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-Process adb -ErrorAction SilentlyContinue | Select-Object -First 1).Path'], {encoding: 'utf8'});
    const p = (ps.stdout || '').trim();
    if (p && fs.existsSync(p)) return p;
    const sdk = path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
    if (fs.existsSync(sdk)) return sdk;
  }
  return null;
}

/** {path, from} of the adb mdt uses, or null. */
export function resolveAdb(cfg) {
  const own = cfg.device?.adb;
  if (own && fs.existsSync(own)) return {path: own, from: 'mdt.json device.adb'};
  const b = bundledAdb();
  if (b) return {path: b, from: 'mdt/platform-tools'};
  const d = detectAdb();
  return d ? {path: d, from: 'installed'} : null;
}

export function bundledRevision(os) {
  try {
    return fs.readFileSync(path.join(BUNDLE, os, 'source.properties'), 'utf8').match(/Pkg\.Revision\s*=\s*(\S+)/)[1];
  } catch {
    return null;
  }
}

/** `adb version` (doesn't start or contact the adb server). */
export function adbVersion(adb) {
  const r = spawnSync(adb, ['version'], {encoding: 'utf8'});
  return r.status === 0 ? (r.stdout.match(/^Version (\S+)/m) || [, '?'])[1] : null;
}

function curl(url, out) {
  const r = spawnSync(curlExe(), ['-sSfL', '--retry', '2', '-o', out, url], {encoding: 'utf8'});
  if (r.error || r.status !== 0) fail(`download failed: ${url}\n${(r.stderr || r.error?.message || '').trim()}`);
}

function cmpRev(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The newest platform-tools in `channel` or a more stable one, from Google's SDK index. */
export function latestPlatformTools(channel = 'stable') {
  if (!(channel in CHANNELS)) fail(`--channel: one of ${Object.keys(CHANNELS).join(', ')}`);
  fs.mkdirSync(P.tmp, {recursive: true});
  const f = path.join(P.tmp, 'sdk-repository2-3.xml');
  curl(INDEX, f);
  const xml = fs.readFileSync(f, 'utf8');
  fs.rmSync(f, {force: true});
  let best = null;
  for (const [pkg] of xml.matchAll(/<remotePackage path="platform-tools">[\s\S]*?<\/remotePackage>/g)) {
    const ch = Number((pkg.match(/<channelRef ref="channel-(\d)"/) || [, 0])[1]);
    if (ch > CHANNELS[channel]) continue;
    const num = k => Number((pkg.match(new RegExp(`<${k}>(\\d+)</${k}>`)) || [, 0])[1]);
    const rev = [num('major'), num('minor'), num('micro')];
    const archives = {};
    for (const [, a] of pkg.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
      const os = (a.match(/<host-os>(\w+)<\/host-os>/) || [])[1];
      const url = (a.match(/<url>([^<]+)<\/url>/) || [])[1];
      const sha1 = (a.match(/<checksum type="sha1">(\w+)<\/checksum>/) || [])[1];
      if (os && url && sha1) archives[os] = {url: REPO + url, sha1, size: Number((a.match(/<size>(\d+)<\/size>/) || [])[1])};
    }
    if (!best || cmpRev(rev, best.rev) > 0) {
      best = {rev, version: rev.join('.'), channel: Object.keys(CHANNELS)[ch], license: (pkg.match(/<uses-license ref="([^"]+)"/) || [])[1], archives};
    }
  }
  if (!best) fail(`no platform-tools package in ${INDEX}`);
  return best;
}

// A running adb server keeps adb.exe and its DLLs open on Windows: they can be
// renamed but not replaced. The old server keeps running from *.old; the next adb
// call notices the newer client and restarts it.
function place(src, dest) {
  try {
    fs.rmSync(dest, {force: true});
  } catch {
    let old = `${dest}.old`;
    try {
      fs.rmSync(old, {force: true});
    } catch {
      old = `${dest}.${Date.now()}.old`;
    }
    fs.renameSync(dest, old);
  }
  fs.copyFileSync(src, dest);
}

// virus scanners briefly lock freshly unpacked .exe files: retry, and never fail over temp files
function cleanup(p) {
  try {
    fs.rmSync(p, {recursive: true, force: true, maxRetries: 10, retryDelay: 300});
  } catch {
    warn(`could not remove ${rel(p)} (in use); it is only a temp file`);
  }
}

function unpack(zip, dir) {
  // Windows and macOS tar (bsdtar) read zips; GNU tar doesn't
  const [cmd, args] = process.platform === 'linux' ? ['unzip', ['-q', '-o', zip, '-d', dir]] : [tarExe(), ['-xf', zip, '-C', dir]];
  const r = spawnSync(cmd, args, {encoding: 'utf8'});
  if (r.error || r.status !== 0) fail(`could not unpack ${path.basename(zip)} with ${cmd}: ${(r.stderr || r.error?.message || '').trim()}`);
}

/** mdt adb update: Google's platform-tools -> mdt/platform-tools/<os>/ (only adb). */
export function updateAdb(opt = {}) {
  const present = OSES.filter(o => fs.existsSync(exe(o)));
  const oses = opt.os === 'all' ? OSES : typeof opt.os === 'string' ? opt.os.split(',') : [...new Set([HOST_OS, ...present].filter(Boolean))];
  for (const o of oses) if (!OSES.includes(o)) fail(`--os: ${OSES.join(', ')} or all`);
  const pt = latestPlatformTools(opt.channel || 'stable');
  info(`platform-tools ${pt.version} (${pt.channel} channel, ${pt.license}) from ${REPO}`);
  if (pt.channel !== 'stable') warn(`${pt.version} is a ${pt.channel} build`);
  for (const os of oses) {
    const dest = path.join(BUNDLE, os);
    const have = bundledRevision(os);
    if (have === pt.version && !opt.force) {
      ok(`${os}: already ${have} (${rel(dest)})`);
      continue;
    }
    const a = pt.archives[os];
    if (!a) {
      warn(`${os}: no archive in ${pt.version}`);
      continue;
    }
    const zip = path.join(P.tmp, path.basename(a.url));
    info(`${os}: ${a.url} (${(a.size / 1048576).toFixed(1)} MB)`);
    curl(a.url, zip);
    const buf = fs.readFileSync(zip);
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    if (sha1 !== a.sha1 || (a.size && buf.length !== a.size)) {
      cleanup(zip);
      fail(`${os}: ${path.basename(a.url)} doesn't match Google's index (sha1 ${sha1}, expected ${a.sha1})`);
    }
    const x = path.join(P.tmp, `platform-tools-${os}`);
    cleanup(x);
    fs.mkdirSync(x, {recursive: true});
    unpack(zip, x);
    const src = path.join(x, 'platform-tools');
    const want = [...KEEP[os], ...META];
    for (const f of want) if (!fs.existsSync(path.join(src, f))) fail(`${os}: ${f} is missing from ${path.basename(a.url)}`);
    fs.mkdirSync(dest, {recursive: true});
    for (const f of fs.readdirSync(dest)) {
      if (want.includes(f)) continue;
      try {
        fs.rmSync(path.join(dest, f), {force: true}); // files from older layouts, leftover *.old
      } catch {}
    }
    for (const f of want) place(path.join(src, f), path.join(dest, f));
    if (os !== 'windows') fs.chmodSync(exe(os), 0o755);
    cleanup(x);
    cleanup(zip);
    ok(`${os}: adb ${have ? `${have} -> ` : ''}${pt.version} in ${rel(dest)} (sha1 verified)`);
  }
  if (HOST_OS && oses.includes(HOST_OS) && fs.existsSync(exe(HOST_OS))) {
    const v = adbVersion(exe(HOST_OS));
    if (!v) fail(`${rel(exe(HOST_OS))} doesn't run`);
    info(`${rel(exe(HOST_OS))}: adb version ${v}`);
  }
}
