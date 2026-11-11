// Driving the app on the device over the WebView DevTools protocol (CDP).
// Everything runs against the Navigator page; app code lives in its
// same-origin iframe #navigator_Iframe, reached via contentWindow.
//
// Read-only: ui, wait, scroll, state, console, screenshot, logcat
// Changes app state: tap, type, key, eval (policy: device-ui)
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {P, fail, info, stamp} from './util.mjs';

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

export class Cdp {
  static async open(dev) {
    const sock = dev.devtoolsSocket();
    if (!sock) fail(`no WebView DevTools socket: is ${dev.pkg} running?`);
    const port = await freePort();
    dev.cap(['forward', `tcp:${port}`, `localabstract:${sock}`]);
    const s = new Cdp(dev, port);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(10000)})).json();
      const page = list.find(t => t.type === 'page' && t.url.includes('/www/apps/navigator/')) || list.find(t => t.type === 'page');
      if (!page) fail('no WebView page found');
      s.ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        s.ws.onopen = res;
        s.ws.onerror = () => rej(new Error('DevTools websocket failed'));
      });
      s.ws.onmessage = ev => s._msg(JSON.parse(ev.data));
      return s;
    } catch (e) {
      s.close();
      throw e;
    }
  }
  constructor(dev, port) {
    this.dev = dev;
    this.port = port;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
  }
  _msg(m) {
    if (m.id && this.pending.has(m.id)) {
      this.pending.get(m.id)(m);
      this.pending.delete(m.id);
    } else if (m.method) for (const l of this.listeners) l(m);
  }
  send(method, params = {}, timeoutMs = 20000) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`DevTools ${method} got no answer in ${timeoutMs / 1000}s${method.startsWith('Page.') ? ' (screen off?)' : ''}`));
      }, timeoutMs);
      this.pending.set(id, m => {
        clearTimeout(timer);
        res(m);
      });
      this.ws.send(JSON.stringify({id, method, params}));
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (r.error) fail(`DevTools: ${r.error.message}`);
    if (r.result?.exceptionDetails) fail(`page error: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  }
  close() {
    try {
      this.ws?.close();
    } catch {
      /* closing anyway */
    }
    this.dev.cap(['forward', '--remove', `tcp:${this.port}`], {allowFail: true});
  }
}

async function withCdp(dev, fn) {
  const s = await Cdp.open(dev);
  try {
    return await fn(s);
  } finally {
    s.close();
  }
}

// ---------------------------------------------------------------- page-side helpers

const INTERACTIVE =
  'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[role=radio],[role=combobox],[tabindex]:not([tabindex="-1"])';

// shared JS put in front of every page script: picks the app frame (or Navigator)
const PRELUDE = `
const __SEL = ${JSON.stringify(INTERACTIVE)};
const __ctx = (want) => {
  const f = document.getElementById('navigator_Iframe');
  const open = !!(f && f.style.display !== 'none' && f.contentWindow && f.contentDocument);
  let useFrame = open && want !== 'navigator';
  if (want && want !== 'current' && want !== 'navigator') {
    if (!open || !f.contentWindow.location.href.includes('/apps/' + want + '/')) return {error: 'app ' + want + ' is not open in Navigator'};
  }
  const win = useFrame ? f.contentWindow : window;
  const r = useFrame ? f.getBoundingClientRect() : {left: 0, top: 0};
  const app = useFrame ? ((win.location.pathname.match(/apps\\/([^/]+)/) || [])[1] || '?') : 'navigator';
  return {win, doc: win.document, ox: r.left, oy: r.top, app};
};
const __vis = (c, el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  if (r.bottom < 0 || r.right < 0 || r.top > c.win.innerHeight || r.left > c.win.innerWidth) return null;
  const cs = c.win.getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
  return r;
};
// Graphite puts button text in a non-standard label="" attribute and icons in
// <svg aria-label="..."> or class "Carbon:renew"
const __label = (el) => {
  const svg = el.querySelector && el.querySelector('svg');
  const icon = svg && (svg.getAttribute('aria-label') || (svg.querySelector('title') || {}).textContent ||
    ((String(svg.className && svg.className.baseVal || '').match(/(?:carbon|maximo):([\\w-]+)/i) || [])[1] && 'icon:' + String(svg.className.baseVal).match(/(?:carbon|maximo):([\\w-]+)/i)[1]));
  const t = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('label') ||
    el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || icon || el.getAttribute('name') || '';
  return String(t).replace(/\\s+/g, ' ').trim().slice(0, 90);
};
const __norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
// text of the nearest container (card, row) to tell similar buttons apart
const __context = (el, own) => {
  let e = el.parentElement;
  for (let i = 0; e && i < 10; i++, e = e.parentElement) {
    const t = (e.innerText || '').replace(/\\s+/g, ' ').trim();
    if (t.length > own.length + 3 && t.length < 600) return t.slice(0, 70);
    if (t.length >= 600) return '';
  }
  return '';
};
// interactive elements + outermost cursor:pointer elements (React click handlers)
const __cands = (c) => {
  const set = new Set([...c.doc.querySelectorAll(__SEL)]);
  const all = c.doc.body.getElementsByTagName('*');
  if (all.length < 8000) {
    for (const e of all) {
      if (set.has(e)) continue;
      if (c.win.getComputedStyle(e).cursor !== 'pointer') continue;
      const p = e.parentElement;
      if (p && c.win.getComputedStyle(p).cursor === 'pointer') continue;
      if (e.closest(__SEL)) continue;
      set.add(e);
    }
  }
  return [...set].filter(e => __vis(c, e));
};
const __find = (c, t) => {
  if (t.ref) return c.doc.querySelector('[data-mdt-ref="' + t.ref + '"]');
  if (t.id) return c.doc.getElementById(t.id);
  if (t.selector) return c.doc.querySelector(t.selector);
  const want = __norm(t.text);
  const cands = __cands(c);
  let hits = cands.filter(e => __norm(__label(e)) === want);
  if (!hits.length) hits = cands.filter(e => __norm(__label(e)).includes(want));
  if (hits.length > 1 && !t.nth) return {ambiguous: hits.slice(0, 12).map(__label)};
  return hits[(t.nth || 1) - 1] || null;
};
`;

const pageScript = (body, args) => `(async () => { ${PRELUDE}; const A = ${JSON.stringify(args)}; ${body} })()`;

// ---------------------------------------------------------------- commands

export async function uiDump(dev, {app = 'current', all = false, textLimit = 2500} = {}) {
  return withCdp(dev, s =>
    s.evaluate(
      pageScript(
        `
    const c = __ctx(A.app); if (c.error) return c;
    c.doc.querySelectorAll('[data-mdt-ref]').forEach(e => e.removeAttribute('data-mdt-ref'));
    const picked = new Set(); const items = []; let n = 0;
    const order = __cands(c).sort((a, b) => (a.compareDocumentPosition(b) & 4) ? -1 : 1);
    for (const el of order) {
      const parent = el.parentElement && el.parentElement.closest(__SEL);
      if (parent && picked.has(parent) && __label(parent) === __label(el)) continue;
      picked.add(el);
      const ref = ++n; el.setAttribute('data-mdt-ref', String(ref));
      const tag = el.tagName.toLowerCase();
      const label = __label(el);
      const weak = !label || /^(icon|carbon|maximo):/i.test(label) || label.length < 12;
      items.push({ref, tag, role: el.getAttribute('role') || undefined, type: el.getAttribute('type') || undefined,
        label, id: el.id || undefined, context: weak ? __context(el, label) || undefined : undefined,
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true') || undefined,
        checked: (el.checked === true || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true') || undefined,
        value: (tag === 'input' || tag === 'textarea' || tag === 'select') ? String(el.value).slice(0, 60) : undefined});
      if (!A.all && items.length >= 150) break;
    }
    const headings = [...c.doc.querySelectorAll('h1,h2,h3,h4,[role=heading]')].filter(e => __vis(c, e)).map(__label).filter(Boolean).slice(0, 12);
    const dialogs = [...c.doc.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(e => __vis(c, e)).map(e => __label(e).slice(0, 120));
    const text = (c.doc.body.innerText || '').replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n').trim();
    return {app: c.app, url: c.win.location.href.replace(/^.*\\/www\\/apps\\//, ''), title: c.doc.title, headings, dialogs, items,
      text: text.slice(0, A.textLimit), textTruncated: text.length > A.textLimit};
  `,
        {app, all, textLimit}
      )
    )
  );
}

export function formatUi(u) {
  if (u.error) return `[mdt] ${u.error}`;
  const lines = [`app ${u.app}  ${u.url}`];
  if (u.headings.length) lines.push(`headings: ${u.headings.join(' | ')}`);
  if (u.dialogs.length) lines.push(`dialogs: ${u.dialogs.join(' | ')}`);
  lines.push('');
  for (const i of u.items) {
    const kind = i.role || (i.type && i.tag === 'input' ? `input:${i.type}` : i.tag);
    const flags = [i.disabled && 'disabled', i.checked && 'checked', i.value !== undefined && `value="${i.value}"`].filter(Boolean).join(' ');
    const id = i.id && !/^[a-z0-9]{5}$/.test(i.id) ? ` #${i.id}` : i.id ? ` #${i.id}` : '';
    lines.push(`[${i.ref}] ${kind} "${i.label}"${flags ? ` ${flags}` : ''}${id}${i.context ? `  (in: ${i.context})` : ''}`);
  }
  lines.push('', '--- text', u.text + (u.textTruncated ? '\n...(truncated, --text-limit N)' : ''));
  return lines.join('\n');
}

function targetOf(opt, positional) {
  const t = {nth: opt.nth ? Number(opt.nth) : undefined};
  if (opt.id) t.id = String(opt.id);
  else if (opt.selector) t.selector = String(opt.selector);
  else if (opt.text) t.text = String(opt.text);
  else if (/^\d+$/.test(String(positional || ''))) t.ref = String(positional);
  else if (positional) t.text = String(positional);
  else fail('which element? pass a ref from `mdt ui` (e.g. 12), visible text, or --selector <css>');
  return t;
}

async function locate(s, app, target) {
  const r = await s.evaluate(
    pageScript(
      `
    const c = __ctx(A.app); if (c.error) return c;
    const el = __find(c, A.t);
    if (!el) return {error: 'element not found' + (A.t.ref ? ' (refs change: run mdt ui again)' : '')};
    if (el.ambiguous) return {error: 'several elements match, pass --nth N or a ref', matches: el.ambiguous};
    el.scrollIntoView({block: 'center', inline: 'center'});
    await new Promise(r => setTimeout(r, 150));
    const r = el.getBoundingClientRect();
    return {x: c.ox + r.left + r.width / 2, y: c.oy + r.top + r.height / 2, label: __label(el), tag: el.tagName.toLowerCase()};
  `,
      {app, t: target}
    )
  );
  if (r?.error) fail(`${r.error}${r.matches ? `:\n  ${r.matches.join('\n  ')}` : ''}`);
  return r;
}

async function click(s, x, y) {
  await s.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
  await s.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1});
  await s.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1});
}

export async function tap(dev, positional, opt) {
  if (opt.xy) {
    const [x, y] = String(opt.xy).split(',').map(Number);
    dev.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
    return info(`tapped screen at ${x},${y} (device pixels)`);
  }
  const t = targetOf(opt, positional);
  return withCdp(dev, async s => {
    const el = await locate(s, opt.app || 'current', t);
    if (opt.js) {
      await s.evaluate(pageScript(`const c = __ctx(A.app); const el = __find(c, A.t); el.click(); return true;`, {app: opt.app || 'current', t}));
    } else await click(s, el.x, el.y);
    info(`tapped ${el.tag} "${el.label}"`);
  });
}

export async function type(dev, positional, text, opt) {
  if (text === undefined) fail('usage: mdt type <ref|text|--selector css> "<text>" [--clear] [--enter]');
  const t = targetOf(opt, positional);
  return withCdp(dev, async s => {
    const el = await locate(s, opt.app || 'current', t);
    await click(s, el.x, el.y);
    if (opt.clear) {
      await s.evaluate(
        pageScript(
          `const c = __ctx(A.app); const el = c.doc.activeElement; if (!el) return false;
           const proto = el.tagName === 'TEXTAREA' ? c.win.HTMLTextAreaElement.prototype : c.win.HTMLInputElement.prototype;
           const set = Object.getOwnPropertyDescriptor(proto, 'value').set; set.call(el, '');
           el.dispatchEvent(new c.win.Event('input', {bubbles: true})); return true;`,
          {app: opt.app || 'current'}
        )
      );
    }
    await s.send('Input.insertText', {text: String(text)});
    if (opt.enter) await pressKey(s, 'Enter');
    info(`typed into ${el.tag} "${el.label}"`);
  });
}

const KEYS = {
  Enter: {key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r'},
  Tab: {key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9},
  Escape: {key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27},
  Backspace: {key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8},
  ArrowDown: {key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40},
  ArrowUp: {key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38}
};

async function pressKey(s, name) {
  const k = KEYS[name];
  await s.send('Input.dispatchKeyEvent', {type: k.text ? 'keyDown' : 'rawKeyDown', ...k});
  await s.send('Input.dispatchKeyEvent', {type: 'keyUp', ...k, text: undefined});
}

/** read-only: Awake | Asleep | Dozing | Dreaming */
export function screenState(dev) {
  return (dev.shell('dumpsys power', {allowFail: true}).match(/mWakefulness=(\w+)/) || [])[1] || 'unknown';
}

export async function key(dev, name) {
  if (/^back$/i.test(name)) {
    dev.shell('input keyevent KEYCODE_BACK');
    return info('pressed Android Back');
  }
  if (/^wake(up)?$/i.test(name)) {
    dev.shell('input keyevent KEYCODE_WAKEUP');
    return info(`screen: ${screenState(dev)} (a lock screen, if set, still needs the user)`);
  }
  const k = Object.keys(KEYS).find(x => x.toLowerCase() === String(name).toLowerCase());
  if (!k) fail(`keys: back, wake, ${Object.keys(KEYS).join(', ')}`);
  return withCdp(dev, async s => {
    await pressKey(s, k);
    info(`pressed ${k}`);
  });
}

export async function scroll(dev, where = 'down', opt = {}) {
  return withCdp(dev, async s => {
    const r = await s.evaluate(
      pageScript(
        `
      const c = __ctx(A.app); if (c.error) return c;
      if (/^\\d+$/.test(A.where)) { const el = c.doc.querySelector('[data-mdt-ref="' + A.where + '"]'); if (!el) return {error: 'ref not found'}; el.scrollIntoView({block: 'center'}); return {scrolled: 'ref ' + A.where}; }
      let el = c.doc.elementFromPoint(c.win.innerWidth / 2, c.win.innerHeight / 2);
      while (el && el !== c.doc.body) { const cs = c.win.getComputedStyle(el); if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4) break; el = el.parentElement; }
      const box = el && el !== c.doc.body ? el : c.doc.scrollingElement;
      const dy = (A.where === 'up' ? -1 : 1) * Math.round(box.clientHeight * 0.8);
      const before = box.scrollTop; box.scrollBy(0, dy);
      await new Promise(r => setTimeout(r, 300));
      return {scrolled: A.where, moved: box.scrollTop - before, atEnd: box.scrollTop + box.clientHeight >= box.scrollHeight - 2};
    `,
        {app: opt.app || 'current', where: String(where)}
      )
    );
    if (r?.error) fail(r.error);
    info(`scrolled ${r.scrolled}${r.moved !== undefined ? ` (${r.moved}px${r.atEnd ? ', at the end' : ''})` : ''}`);
  });
}

export async function waitFor(dev, what, opt = {}) {
  const timeout = Number(opt.timeout || 20) * 1000;
  const t0 = Date.now();
  return withCdp(dev, async s => {
    for (;;) {
      const r = await s.evaluate(
        pageScript(
          `
        const c = __ctx(A.app); if (c.error) return {found: false, why: c.error};
        if (A.selector) { const el = c.doc.querySelector(A.selector); return {found: !!(el && __vis(c, el))}; }
        return {found: __norm(c.doc.body.innerText).includes(__norm(A.text))};
      `,
          {app: opt.app || 'current', selector: opt.selector || null, text: what}
        )
      );
      const done = opt.gone ? !r.found : r.found;
      if (done) return info(`${opt.gone ? 'gone' : 'found'}: ${opt.selector || what} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      if (Date.now() - t0 > timeout) fail(`timeout after ${timeout / 1000}s waiting for ${opt.gone ? 'disappearance of ' : ''}${opt.selector || `"${what}"`}${r.why ? ` (${r.why})` : ''}`);
      await new Promise(res => setTimeout(res, 500));
    }
  });
}

export async function evalJs(dev, code, opt = {}) {
  return withCdp(dev, s =>
    s.evaluate(
      pageScript(
        `const c = __ctx(A.app); if (c.error) return c; const v = await c.win.eval(A.code);
         try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch (e) { return String(v); }`,
        {app: opt.app || 'current', code}
      )
    )
  );
}

// window.__mdt.app is added to debug builds by mdt/container/test-hook.js
export async function appState(dev, opt = {}) {
  return withCdp(dev, s =>
    s.evaluate(
      pageScript(
        `
    const c = __ctx(A.app); if (c.error) return c;
    const app = c.win.__mdt && c.win.__mdt.app;
    if (!app) return {app: c.app, hook: false};
    const flat = o => { const r = {}; if (!o) return r; for (const k of Object.keys(o).slice(0, 60)) { const v = o[k];
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) r[k] = v; else if (Array.isArray(v)) r[k] = '[' + v.length + ']'; } return r; };
    const page = app.currentPage;
    const ds = page ? Object.values(page.datasources || {}) : [];
    return {app: app.name, hook: true, page: page && page.name, pageStack: (page && page.getPageStack ? page.getPageStack() : []).map(p => p && (p.name || p)).slice(-8),
      pageState: flat(page && page.state), appState: flat(app.state),
      datasources: ds.map(d => ({name: d.name, items: d.state && d.state.itemCount, total: d.state && d.state.totalCount, loading: d.state && d.state.loading, error: d.state && d.state.error ? String(d.state.error) : undefined}))};
  `,
        {app: opt.app || 'current'}
      )
    )
  );
}

/** Console messages + exceptions: replayed history plus N seconds of live output. */
export async function consoleLog(dev, opt = {}, beforeCollect = null) {
  const seconds = Number(opt.seconds || 3);
  return withCdp(dev, async s => {
    const out = [];
    s.on(m => {
      if (m.method === 'Runtime.consoleAPICalled') {
        const p = m.params;
        const text = p.args.map(a => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.type)).join(' ');
        out.push({level: p.type, text, at: p.stackTrace?.callFrames?.[0]?.url?.replace(/^.*\/www\/apps\//, '')});
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        out.push({level: 'exception', text: d.exception?.description || d.text, at: d.url?.replace(/^.*\/www\/apps\//, '')});
      } else if (m.method === 'Log.entryAdded') {
        const e = m.params.entry;
        out.push({level: e.level, text: e.text, at: e.url?.replace(/^.*\/www\/apps\//, '')});
      }
    });
    await s.send('Runtime.enable');
    await s.send('Log.enable');
    if (beforeCollect) await beforeCollect(s);
    await new Promise(res => setTimeout(res, seconds * 1000));
    const levels = opt.errors ? /^(error|exception|assert|warning)$/ : /./;
    return out.filter(e => levels.test(e.level));
  });
}

function requireAwake(dev) {
  const st = screenState(dev);
  if (st !== 'Awake') fail(`the screen is off (${st}): screenshots come back black. Wake it with \`mdt key wake\` (device-ui) or on the device. mdt ui/state/console work with the screen off.`);
}

export function screenshot(dev, file) {
  requireAwake(dev);
  file ??= path.join(P.state, 'screens', `${stamp()}.png`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const fd = fs.openSync(file, 'w');
  try {
    dev.cap(['exec-out', 'screencap', '-p'], {stdio: ['ignore', fd, 'pipe'], binary: true});
  } finally {
    fs.closeSync(fd);
  }
  if (fs.statSync(file).size < 1000) fail('screenshot came back empty (screen off or locked?)');
  return file;
}

export async function webviewScreenshot(dev, file) {
  requireAwake(dev);
  file ??= path.join(P.state, 'screens', `${stamp()}-webview.png`);
  return withCdp(dev, async s => {
    const r = await s.send('Page.captureScreenshot', {format: 'png'}, 10000);
    if (!r.result?.data) fail('Page.captureScreenshot failed');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  });
}

export function logcat(dev, opt = {}) {
  const pid = dev.pids()[0];
  const args = ['logcat', '-d', '-t', String(opt.lines || 200)];
  if (pid && !opt.all) args.push(`--pid=${pid}`);
  let text = dev.cap(args, {allowFail: true}).stdout || '';
  if (opt.grep) {
    const re = new RegExp(String(opt.grep), 'i');
    text = text
      .split(/\r?\n/)
      .filter(l => re.test(l))
      .join('\n');
  }
  return text;
}
