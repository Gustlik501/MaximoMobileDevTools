// Debuggable Maximo Mobile APK over adb: run-as for the app sandbox, the
// WebView DevTools socket for reloads. Read-only helpers are marked.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {APP_ID_RE, P, capture, fail, info, ok, rel, run, sha256File, stamp, warn} from './util.mjs';

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

export class Device {
  constructor(cfg, opt = {}) {
    this.adb = (cfg.device.adb && fs.existsSync(cfg.device.adb) && cfg.device.adb) || detectAdb() || 'adb';
    this.serial = opt.serial || cfg.device.serial || null;
    this.pkg = cfg.device.package || 'com.ibm.iot.maximo.mobile';
  }
  args(a) {
    return this.serial ? ['-s', this.serial, ...a] : a;
  }
  cap(a, opts) {
    return capture(this.adb, this.args(a), opts);
  }
  shell(cmd, opts) {
    return this.cap(['shell', cmd], opts).stdout;
  }
  /** command as the app user (needs a debuggable APK); no single quotes allowed */
  runAs(cmd, opts) {
    if (cmd.includes("'")) fail('internal: single quote in run-as command');
    return this.cap(['shell', `run-as ${this.pkg} sh -c '${cmd}'`], opts);
  }
  devices() {
    const r = capture(this.adb, ['devices'], {allowFail: true});
    return (r.stdout || '').split(/\r?\n/).slice(1).filter(l => /\tdevice$/.test(l)).map(l => l.split('\t')[0]);
  }
  /** read-only: pick the device and check run-as works */
  ensure() {
    const devs = this.devices();
    if (!devs.length) fail('no adb device connected (adb devices is empty)');
    if (!this.serial && devs.length > 1) fail(`several devices connected (${devs.join(', ')}), pass --serial <id>`);
    if (this.serial && !devs.includes(this.serial)) fail(`device ${this.serial} not connected`);
    this.serial ??= devs[0];
    const r = this.runAs('echo ok', {allowFail: true});
    if (!/ok/.test(r.stdout)) {
      fail(`run-as ${this.pkg} failed: ${String(r.stderr || r.stdout).trim()}\n  The Maximo Mobile APK must be a debuggable build.`);
    }
    return this;
  }
  appDir(appId) {
    if (!APP_ID_RE.test(appId)) fail(`bad app id ${appId}`);
    return `files/www/apps/${appId}`;
  }
  /** read-only */
  listApps() {
    return this.runAs('ls files/www/apps', {allowFail: true}).stdout.split(/\s+/).filter(x => APP_ID_RE.test(x));
  }
  /** read-only */
  cat(file) {
    return this.cap(['exec-out', `run-as ${this.pkg} cat ${file}`], {allowFail: true}).stdout;
  }
  readBuildJson(appId) {
    try {
      return JSON.parse(this.cat(`${this.appDir(appId)}/build.json`));
    } catch {
      return null;
    }
  }
  pids() {
    return this.shell(`pidof ${this.pkg}`, {allowFail: true}).trim().split(/\s+/).filter(Boolean);
  }
  devtoolsSocket() {
    const pids = this.pids();
    const unix = this.shell('cat /proc/net/unix', {allowFail: true});
    const pid = [...unix.matchAll(/@webview_devtools_remote_(\d+)/g)].map(m => m[1]).find(s => pids.includes(s));
    return pid ? `webview_devtools_remote_${pid}` : null;
  }
  /** read-only: stream a command's stdout into a local file */
  pullTo(cmd, file) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const fd = fs.openSync(file, 'w');
    try {
      this.cap(['exec-out', `run-as ${this.pkg} ${cmd}`], {stdio: ['ignore', fd, 'pipe'], binary: true});
    } finally {
      fs.closeSync(fd);
    }
    return fs.statSync(file).size;
  }
}

/**
 * read-only: the VITE_* values the MAS config pod built the installed apps with
 * (they end up in assets/process-polyfill-*.js).
 */
export function detectBuildEnv(dev, preferApp) {
  const apps = dev.listApps();
  const order = [preferApp, ...apps.filter(a => a !== 'navigator'), 'navigator'].filter(a => a && apps.includes(a));
  for (const appId of order) {
    const files = dev.runAs(`ls ${dev.appDir(appId)}/assets`, {allowFail: true}).stdout.split(/\s+/);
    const poly = files.find(f => /^process-polyfill-.*\.js$/.test(f));
    if (!poly) continue;
    const m = dev.cat(`${dev.appDir(appId)}/assets/${poly}`).match(/env:\s*(\{[\s\S]*?\})\s*\};?/);
    if (!m) continue;
    try {
      const env = JSON.parse(m[1]);
      const vite = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('VITE_')));
      if (Object.keys(vite).length) return {appId, env: vite};
    } catch {
      /* try the next app */
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const {port} = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** Evaluate JS in the Navigator page over the Chrome DevTools protocol. */
export async function cdpEvaluate(dev, expression, {settleMs = 0} = {}) {
  const sock = dev.devtoolsSocket();
  if (!sock) fail(`no WebView DevTools socket: is ${dev.pkg} running?`);
  const port = await freePort();
  dev.cap(['forward', `tcp:${port}`, `localabstract:${sock}`]);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find(t => t.type === 'page' && t.url.includes('/www/apps/navigator/')) || list.find(t => t.type === 'page');
    if (!page) fail('no WebView page found');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('DevTools websocket failed'));
    });
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    };
    const send = (method, params = {}) =>
      new Promise(res => {
        const mid = ++id;
        pending.set(mid, res);
        ws.send(JSON.stringify({id: mid, method, params}));
      });
    await send('Network.enable');
    await send('Network.setCacheDisabled', {cacheDisabled: true});
    const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (settleMs) await new Promise(res => setTimeout(res, settleMs));
    ws.close();
    if (r.result?.exceptionDetails) fail(`page error: ${r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  } finally {
    dev.cap(['forward', '--remove', `tcp:${port}`], {allowFail: true});
  }
}

const reloadExpr = appId =>
  appId === 'navigator'
    ? `(() => { setTimeout(() => location.reload(), 50); return 'reloaded'; })()`
    : `(() => {
        const f = document.getElementById('navigator_Iframe');
        if (!f || f.style.display === 'none' || !f.contentWindow.location.href.includes('/apps/${appId}/')) return 'not-open';
        f.contentWindow.location.reload();
        return 'reloaded';
      })()`;

/** WRITES: reloads the app in the WebView (or restarts the APK with --restart) */
export async function reload(dev, appId, {restart = false} = {}) {
  if (restart) {
    dev.shell(`am force-stop ${dev.pkg}`);
    dev.shell(`monkey -p ${dev.pkg} -c android.intent.category.LAUNCHER 1`, {allowFail: true});
    return info('restarted Maximo Mobile');
  }
  try {
    const res = await cdpEvaluate(dev, reloadExpr(appId), {settleMs: 2500});
    if (res === 'reloaded') info(`reloaded ${appId}`);
    else warn(`${appId} is not open in Navigator: open it on the device (or use --restart)`);
  } catch (e) {
    warn(`reload skipped: ${e.message}`);
  }
}

/** read-only: tar of files/www/apps/<app> into .mdt/backups/<app>/ */
export function backup(dev, appId) {
  const file = path.join(P.backups(appId), `${stamp()}.tar`);
  const size = dev.pullTo(`tar -C files/www/apps -cf - ${appId}`, file);
  if (size < 10240) {
    fs.unlinkSync(file);
    fail(`backup of ${appId} came back empty`);
  }
  info(`backup: ${rel(file)} (${(size / 1e6).toFixed(1)} MB)`);
  return file;
}

/** WRITES: copy a local file into the app sandbox cache/, returns the sandbox path */
function uploadToSandbox(dev, localFile, name) {
  const target = `cache/${name}`;
  const want = fs.statSync(localFile).size;
  const sizeOnDevice = () => Number(dev.runAs(`wc -c < ${target}`, {allowFail: true}).stdout.trim());
  // 1) stream through adb exec-in straight into the sandbox
  const r = spawnSync(dev.adb, dev.args(['exec-in', `run-as ${dev.pkg} sh -c 'cat > ${target}'`]), {input: fs.readFileSync(localFile), maxBuffer: 1 << 30});
  if (r.status === 0 && sizeOnDevice() === want) return target;
  // 2) fall back to /data/local/tmp + run-as cp
  const tmp = `/data/local/tmp/${name}`;
  dev.cap(['push', localFile, tmp]);
  dev.runAs(`cp ${tmp} ${target}`);
  dev.shell(`rm -f ${tmp}`, {allowFail: true});
  if (sizeOnDevice() !== want) fail('could not copy the bundle into the app sandbox');
  return target;
}

/** WRITES: replace files/www/apps/<app> with a built bundle */
export function pushBundle(dev, appId, zipFile, indexHtml, {keepOldAssets = false} = {}) {
  const dir = dev.appDir(appId);
  const sandboxZip = uploadToSandbox(dev, zipFile, `mdt-${appId}.zip`);
  const clean = keepOldAssets ? '' : `rm -rf ${dir}/assets && `;
  dev.runAs(`${clean}unzip -o -q -d ${dir} ${sandboxZip} && rm -f ${sandboxZip}`);
  const local = sha256File(indexHtml);
  const remote = dev.runAs(`sha256sum ${dir}/index.html`).stdout.trim().split(/\s+/)[0];
  if (local !== remote) fail(`verification failed: index.html on device ${remote.slice(0, 12)} != local ${local.slice(0, 12)}`);
}

/** WRITES: put a backup tar back */
export function restoreBackup(dev, appId, tarFile) {
  const t = uploadToSandbox(dev, tarFile, `mdt-restore-${appId}.tar`);
  dev.runAs(`rm -rf ${dev.appDir(appId)}/assets && tar -C files/www/apps -xf ${t} && rm -f ${t}`);
  ok(`restored ${appId} from ${rel(tarFile)}`);
}

export function printDevice(dev) {
  run(dev.adb, ['devices', '-l']);
  dev.ensure();
  const dump = dev.shell(`dumpsys package ${dev.pkg}`);
  const ver = (dump.match(/versionName=(\S+)/) || [])[1];
  const dbg = /pkgFlags=\[[^\]]*DEBUGGABLE/.test(dump);
  console.log(`${dev.pkg} ${ver} ${dbg ? 'DEBUGGABLE' : 'not debuggable'}`);
  const sock = dev.devtoolsSocket();
  console.log(`WebView DevTools: ${sock || 'app not running'}`);
  for (const appId of dev.listApps()) {
    const b = dev.readBuildJson(appId);
    console.log(`  ${appId.padEnd(14)} ${String(b?.version || '?').padEnd(10)} app-processor ${b?.appProcessorVersion || '?'}`);
  }
}
