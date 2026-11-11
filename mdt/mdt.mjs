#!/usr/bin/env node
/*
 * mdt - Maximo Mobile dev toolkit. See README.md (usage) and docs/internals.md
 * (how the IBM image, the build and the device fit together).
 *
 * Requires Node >= 22, Podman (or Docker), git, curl; adb for device commands.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import * as fw from './lib/framework.mjs';
import {checkEngine, containerRun, containerScript, engine, engineStatus, imageExists, imageIdFromTar, inspectImage, loadImage} from './lib/container.mjs';
import {Device, backup, detectAdb, detectBuildEnv, printDevice, pushBundle, reload, restoreBackup} from './lib/device.mjs';
import {describeTarget, loadTarget, uploadZip} from './lib/upload.mjs';
import {
  APP_ID_RE,
  DEFAULT_PACKAGES,
  MdtError,
  P,
  ROOT,
  TOOL_DIR,
  abs,
  appOf,
  c,
  capture,
  confirm,
  fail,
  info,
  loadCfg,
  ok,
  profileOf,
  readAppInfo,
  readJson,
  rel,
  run,
  saveCfg,
  sha256File,
  stamp,
  tarExe,
  walk,
  warn
} from './lib/util.mjs';

// ================================================================ setup

function doctor(cfg, {quiet = false} = {}) {
  const rows = [];
  const add = (name, good, detail) => rows.push({name, good, detail});
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22, `v${process.versions.node}${major >= 22 ? '' : ' (need >= 22)'}`);
  let es = engineStatus(cfg);
  if (!es.ok && engine(cfg) === 'podman' && process.platform !== 'linux') {
    info('podman is not ready, trying `podman machine start` ...');
    spawnSync('podman', ['machine', 'start'], {stdio: 'inherit'});
    es = engineStatus(cfg);
  }
  add(engine(cfg), es.ok, es.ok ? `ready (${es.arch})` : es.why);
  const git = spawnSync('git', ['--version'], {encoding: 'utf8'});
  add('git', git.status === 0, (git.stdout || 'missing').trim());
  const curl = spawnSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe') : 'curl', ['--version'], {encoding: 'utf8'});
  add('curl', curl.status === 0, (curl.stdout || 'missing').split('\n')[0].trim());
  const adb = (cfg.device.adb && fs.existsSync(cfg.device.adb) && cfg.device.adb) || detectAdb();
  add('adb', !!adb, adb || 'not found (only needed for device commands)');
  if (adb) {
    const dev = new Device({...cfg, device: {...cfg.device, adb}});
    const devs = dev.devices();
    add('device', devs.length > 0, devs.length ? devs.join(', ') : 'none connected');
  }
  if (!quiet) for (const r of rows) console.log(`  ${r.good ? c.green('ok ') : c.yellow('-- ')} ${r.name.padEnd(7)} ${r.detail}`);
  if (major < 22) fail('Node 22 or newer is required');
  return {rows, adb, engineOk: es.ok};
}

async function cmdInit(cfg, {opt}) {
  console.log(c.bold(`mdt workspace: ${ROOT}`));
  const d = doctor(cfg);
  for (const dir of [P.images, P.apps, P.patches, P.targets, path.join(ROOT, 'framework'), path.join(ROOT, 'out'), P.dist, P.state]) {
    fs.mkdirSync(dir, {recursive: true});
  }
  if (d.adb) cfg.device.adb = d.adb;
  saveCfg(cfg);

  // images/*.tar -> one profile each
  if (!d.engineOk) warn('skipping images: container engine not ready');
  else {
    const tars = fs.readdirSync(P.images).filter(f => f.endsWith('.tar')).map(f => path.join(P.images, f));
    if (!tars.length && !Object.keys(cfg.profiles).length) warn('no image yet: copy the graphite-configuration .tar into images/ and run mdt init again');
    for (const t of tars) {
      const known = Object.values(cfg.profiles).find(p => p.tar && abs(p.tar) === t);
      if (known && imageExists(cfg, known.image)) continue;
      imageAdd(cfg, {tar: t}, opt);
    }
    for (const [name, p] of Object.entries(cfg.profiles)) {
      if (!fw.manifest(name) && imageExists(cfg, p.image)) setupFramework(cfg, profileOf(cfg, {profile: name}));
    }
  }

  // apps/* (and legacy top-level app folders)
  for (const base of [P.apps, ROOT]) {
    for (const e of fs.readdirSync(base, {withFileTypes: true})) {
      if (!e.isDirectory() || e.name.startsWith('.') || ['mdt', 'framework', 'out', 'dist', 'images', 'apps', 'patches', 'targets', 'docs'].includes(e.name)) continue;
      const dir = path.join(base, e.name);
      const ai = readAppInfo(dir);
      if (!ai?.id) continue;
      const id = ai.id.toLowerCase();
      if (!cfg.apps[id]) {
        cfg.apps[id] = {src: rel(dir)};
        info(`app ${c.bold(id)} ${ai.version || ''} -> ${rel(dir)}`);
      }
    }
  }
  for (const [id, a] of Object.entries(cfg.apps)) if (!fs.existsSync(abs(a.src))) warn(`app ${id}: ${a.src} no longer exists`);

  // build env from the device, if one is connected (read-only)
  if (d.adb && !Object.keys(cfg.buildEnv).length) {
    try {
      const dev = new Device(cfg, opt).ensure();
      const det = detectBuildEnv(dev);
      if (det) {
        cfg.buildEnv = det.env;
        info(`build env from ${det.appId} on the device: ${Object.entries(det.env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      }
    } catch (e) {
      info(`build env not detected from a device (${e.message.split('\n')[0]}); set it with mdt env set if needed`);
    }
  }

  // active profile: the newest image unless one is chosen
  const byDate = Object.entries(cfg.profiles).sort((a, b) => String(b[1].created || b[1].buildDate).localeCompare(String(a[1].created || a[1].buildDate)));
  if (!cfg.activeProfile || !cfg.profiles[cfg.activeProfile]) cfg.activeProfile = byDate[0]?.[0] || null;
  else if (byDate[0] && byDate[0][0] !== cfg.activeProfile) warn(`newer image registered: ${byDate[0][0]} (switch with: mdt image use ${byDate[0][0]})`);
  saveCfg(cfg);

  console.log('');
  cmdStatus(cfg);
}

function setupFramework(cfg, prof, packages = prof.packages || DEFAULT_PACKAGES, {force = false} = {}) {
  const before = fw.manifest(prof.name) ? fw.patchState(prof.name) : 'none';
  fw.extract(cfg, prof, packages, {force});
  if (before === 'unsaved') {
    warn('kept your unsaved framework edits; patches/framework.patch was not re-applied');
  } else if (fs.existsSync(P.frameworkPatch) && fs.statSync(P.frameworkPatch).size) {
    const r = fw.load(prof.name);
    if (!r.ok) {
      warn(`resolve the *.rej files under framework/${prof.name}, then run: mdt framework save`);
    }
  }
}

function imageAdd(cfg, {tar, id}, opt) {
  checkEngine(cfg);
  if (tar) {
    if (!fs.existsSync(tar)) fail(`not found: ${tar}`);
    info(`reading ${path.basename(tar)} ...`);
    id = imageIdFromTar(tar);
    if (id && imageExists(cfg, id)) info(`image ${id.slice(0, 12)} already loaded`);
    else id = loadImage(cfg, tar) || fail(`could not tell which image ${tar} contains`);
  }
  const im = inspectImage(cfg, id);
  const existing = Object.entries(cfg.profiles).find(([, p]) => p.image === im.fullId);
  let name = opt.name || existing?.[0] || im.labels.version || im.fullId.slice(0, 12);
  if (cfg.profiles[name] && cfg.profiles[name].image !== im.fullId) {
    name = `${im.labels.version}-${im.labels.release}`;
    if (cfg.profiles[name] && cfg.profiles[name].image !== im.fullId) fail(`profile name clash for ${tar || id}: pass --name`);
  }
  cfg.profiles[name] = {
    ...(cfg.profiles[name] || {}),
    tar: tar ? rel(tar) : cfg.profiles[name]?.tar || null,
    image: im.fullId,
    version: im.labels.version,
    release: im.labels.release,
    buildDate: im.labels['build-date'],
    created: im.created,
    tools: im.tools,
    packages: cfg.profiles[name]?.packages || DEFAULT_PACKAGES
  };
  saveCfg(cfg);
  ok(`profile ${c.bold(name)}: graphite-configuration ${im.labels.version}-${im.labels.release}, maximo-js-api ${im.tools['maximo-js-api']}, maxdev-cli ${im.tools['maxdev-cli']}`);
  if (!opt['no-extract'] && !fw.manifest(name)) setupFramework(cfg, profileOf(cfg, {profile: name}));
  return name;
}

function cmdStatus(cfg) {
  console.log(c.bold('profiles (images)'));
  if (!Object.keys(cfg.profiles).length) console.log('  none: put a graphite-configuration .tar into images/ and run mdt init');
  for (const [name, p] of Object.entries(cfg.profiles)) {
    const st = fw.manifest(name) ? fw.status(name) : null;
    const edits = st ? `${fw.editCount(st)} framework edit(s), patch ${fw.patchState(name)}` : 'framework not extracted';
    console.log(`  ${name === cfg.activeProfile ? c.green('*') : ' '} ${c.bold(name.padEnd(12))} ${p.image.slice(0, 12)}  js-api ${p.tools?.['maximo-js-api'] || '?'}  ${edits}`);
  }
  console.log(c.bold('apps'));
  if (!Object.keys(cfg.apps).length) console.log('  none: put app source folders into apps/ and run mdt init');
  for (const [id, a] of Object.entries(cfg.apps)) {
    const ai = readAppInfo(abs(a.src)) || {};
    console.log(`  ${id.padEnd(14)} ${String(ai.version || '?').padEnd(10)} ${a.src}`);
  }
  console.log(c.bold('build env'));
  const env = Object.entries(cfg.buildEnv);
  console.log(env.length ? env.map(([k, v]) => `  ${k}=${v}`).join('\n') : '  (none: mdt env detect | mdt env set VITE_MAS_DOMAIN=...)');
  const targets = fs.existsSync(P.targets) ? fs.readdirSync(P.targets).filter(f => f.endsWith('.json') && f !== 'example.json') : [];
  console.log(c.bold('upload targets'));
  console.log(targets.length ? `  ${targets.map(f => f.replace(/\.json$/, '')).join(', ')}` : '  none (copy targets/example.json)');
}

function cmdImage(cfg, {pos, opt}) {
  const sub = pos[0];
  if (sub === 'list' || !sub) return cmdStatus(cfg);
  if (sub === 'add') {
    if (!pos[1] && !opt.id) fail('usage: mdt image add <file.tar> [--name N] | mdt image add --id <image>');
    let tar = pos[1] ? path.resolve(pos[1]) : null;
    if (tar && !tar.startsWith(P.images)) info('tip: keep image tars in images/ so mdt init finds them on a fresh setup');
    return imageAdd(cfg, {tar, id: opt.id}, opt);
  }
  if (sub === 'use') {
    const prof = profileOf(cfg, {profile: pos[1]});
    cfg.activeProfile = prof.name;
    saveCfg(cfg);
    if (!fw.manifest(prof.name)) setupFramework(cfg, prof);
    return ok(`active profile: ${prof.name}`);
  }
  if (sub === 'remove') return cmdImageRemove(cfg, pos[1], opt);
  if (sub === 'build') return cmdImageBuild(cfg, opt);
  fail(`unknown: mdt image ${sub}`);
}

function cmdImageRemove(cfg, name, opt) {
  const prof = profileOf(cfg, {profile: name});
  if (fw.manifest(prof.name) && fw.patchState(prof.name) === 'unsaved' && !opt.force) {
    fail(`framework/${prof.name} has unsaved edits: run mdt framework save --profile ${prof.name} first (or --force)`);
  }
  fs.rmSync(P.framework(prof.name), {recursive: true, force: true});
  fs.rmSync(P.baseline(prof.name), {recursive: true, force: true});
  delete cfg.profiles[prof.name];
  if (cfg.activeProfile === prof.name) cfg.activeProfile = Object.keys(cfg.profiles)[0] || null;
  saveCfg(cfg);
  if (opt.rmi && !Object.values(cfg.profiles).some(p => p.image === prof.image)) run(engine(cfg), ['rmi', prof.image], {allowFail: true});
  ok(`removed profile ${prof.name}${opt.rmi ? ' and its image' : ''}`);
}

// Bake the saved framework patch into a new image (FROM the IBM image).
function cmdImageBuild(cfg, opt) {
  const prof = profileOf(cfg, opt);
  const st = fw.status(prof.name);
  if (!fw.editCount(st)) fail(`profile ${prof.name} has no framework edits to bake`);
  const state = fw.patchState(prof.name);
  if (state !== 'saved' && !opt['allow-unsaved']) fail(`framework edits are not saved (${state}): run mdt framework save first, so the image matches patches/framework.patch`);
  const ctx = path.join(P.state, 'image-build', prof.name);
  fs.rmSync(ctx, {recursive: true, force: true});
  fs.mkdirSync(path.join(ctx, 'overlay'), {recursive: true});
  info(`compiling ${fw.editCount(st)} framework file(s) with the image's Babel ...`);
  const r = containerRun(
    cfg,
    prof.image,
    [
      [TOOL_DIR, '/mdt', 'ro'],
      [P.framework(prof.name), '/framework', 'ro'],
      [P.baseline(prof.name), '/baseline', 'ro'],
      [ctx, '/out']
    ],
    {},
    'node /mdt/container/compile-framework.cjs --framework /framework --baseline /baseline --overlay /out/overlay --report /out/framework-report.json'
  );
  if (r.status !== 0) fail('framework compile failed');
  const report = readJson(path.join(ctx, 'framework-report.json'));
  const files = [...walk(path.join(ctx, 'overlay'))];
  const staleMaps = files.filter(f => f.endsWith('.js')).map(f => `/graphite/node_modules/@maximo/${f}.map`);
  const patchSha = fw.patchFileSha();
  const tag = opt.tag || `localhost/mdt/graphite-configuration:${prof.version || prof.name}-mdt.${stamp()}`;
  const lines = [
    `# generated by mdt image build - profile ${prof.name}`,
    `FROM ${prof.image}`,
    'USER root',
    'COPY --chown=wiotp:root overlay/ /graphite/node_modules/@maximo/',
    // IBM's external .map files no longer match the patched files (ours carry inline maps)
    ...(staleMaps.length ? [`RUN rm -f ${staleMaps.join(' ')}`] : []),
    `LABEL mdt.base-image="${prof.image}" mdt.profile="${prof.name}" mdt.framework-files="${report.changed.length + report.added.length}" mdt.patch-sha256="${patchSha || ''}"`,
    'USER wiotp',
    ''
  ];
  fs.writeFileSync(path.join(ctx, 'Containerfile'), lines.join('\n'));
  fs.writeFileSync(path.join(ctx, 'CHANGES.txt'), [...report.changed.map(f => `M ${f}`), ...report.added.map(f => `A ${f}`)].join('\n') + '\n');
  if (fs.existsSync(P.frameworkPatch)) fs.copyFileSync(P.frameworkPatch, path.join(ctx, 'framework.patch'));
  info(`building ${tag}`);
  run(engine(cfg), ['build', '-t', tag, '-f', path.join(ctx, 'Containerfile'), ctx]);

  // verify: every overlay file inside the new image matches what we compiled
  const inImage = files.map(f => `/graphite/node_modules/@maximo/${f}`);
  const v = capture(engine(cfg), ['run', '--rm', tag, 'sha256sum', ...inImage]).stdout;
  const want = Object.fromEntries(files.map(f => [`/graphite/node_modules/@maximo/${f}`, sha256File(path.join(ctx, 'overlay', f))]));
  const bad = v.split(/\r?\n/).filter(Boolean).map(l => l.split(/\s+/)).filter(([h, f]) => want[f] !== h);
  if (bad.length) fail(`image verification failed for: ${bad.map(b => b[1]).join(', ')}`);
  ok(`verified ${files.length} file(s) in ${tag}`);

  let saved = null;
  if (opt.save) {
    saved = path.resolve(opt.save === true ? path.join(P.dist, 'images', `graphite-configuration-${prof.name}-mdt-${stamp()}.tar`) : opt.save);
    fs.mkdirSync(path.dirname(saved), {recursive: true});
    info(`saving ${rel(saved)} (docker-archive, same format as IBM's tar) ...`);
    run(engine(cfg), ['save', '--format', 'docker-archive', '-o', saved, tag]);
  }
  cfg.profiles[prof.name].derived = {tag, files: files.length, patchSha, tar: saved ? rel(saved) : null, builtAt: new Date().toISOString()};
  saveCfg(cfg);
  console.log(`\nBuild context: ${rel(ctx)}\nNext: push ${tag} to your registry and point the graphite-configuration deployment at it (README: "Shipping to production").`);
}

function cmdApp(cfg, {pos, opt}) {
  const sub = pos[0];
  if (sub === 'list' || !sub) return cmdStatus(cfg);
  if (sub === 'add') {
    const dir = path.resolve(pos[1] || '');
    const ai = readAppInfo(dir);
    if (!ai?.id) fail(`${dir} has no src/app.xml with an application id`);
    const id = (opt.as || ai.id).toLowerCase();
    cfg.apps[id] = {src: rel(dir)};
    saveCfg(cfg);
    return ok(`app ${id} ${ai.version} -> ${rel(dir)}`);
  }
  if (sub === 'remove') {
    appOf(cfg, pos[1]);
    delete cfg.apps[pos[1].toLowerCase()];
    saveCfg(cfg);
    return ok(`unregistered ${pos[1]} (files untouched)`);
  }
  if (sub === 'import') return cmdAppImport(cfg, pos[1], opt);
  fail(`unknown: mdt app ${sub}`);
}

// Every bundle on the device carries app-source.zip (the full project).
function cmdAppImport(cfg, appId, opt) {
  appId = String(appId || '').toLowerCase();
  if (!APP_ID_RE.test(appId)) fail('usage: mdt app import <appId> [--to Folder]');
  const dest = path.resolve(opt.to || path.join(P.apps, appId.toUpperCase()));
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) fail(`${rel(dest)} exists and is not empty`);
  const dev = new Device(cfg, opt).ensure();
  if (!dev.listApps().includes(appId)) fail(`${appId} is not installed on the device`);
  const zip = path.join(P.tmp, `${appId}-app-source.zip`);
  if (dev.pullTo(`cat ${dev.appDir(appId)}/app-source.zip`, zip) < 100) fail(`no app-source.zip for ${appId} on the device`);
  fs.mkdirSync(dest, {recursive: true});
  run(tarExe(), ['-xf', zip, '-C', dest]);
  fs.rmSync(zip, {force: true});
  const ai = readAppInfo(dest);
  cfg.apps[appId] = {src: rel(dest)};
  saveCfg(cfg);
  ok(`imported ${appId} ${ai?.version || ''} from the device into ${rel(dest)}`);
  warn('these are the sources of the version deployed on the server; put them under git before editing');
}

function cmdEnv(cfg, {pos, opt}) {
  const sub = pos[0];
  if (sub === 'detect') {
    const dev = new Device(cfg, opt).ensure();
    const det = detectBuildEnv(dev, pos[1]);
    if (!det) fail('no VITE_* build env found in the apps on the device');
    cfg.buildEnv = {...cfg.buildEnv, ...det.env};
    saveCfg(cfg);
    ok(`from ${det.appId}: ${Object.entries(det.env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  } else if (sub === 'set') {
    for (const kv of pos.slice(1)) {
      const i = kv.indexOf('=');
      if (i < 1 || !/^(VITE_|REACT_APP_|GRAPHITE_)/.test(kv.slice(0, i))) fail(`expected VITE_X=value (got ${kv})`);
      cfg.buildEnv[kv.slice(0, i)] = kv.slice(i + 1);
    }
    saveCfg(cfg);
  } else if (sub === 'unset') {
    for (const k of pos.slice(1)) delete cfg.buildEnv[k];
    saveCfg(cfg);
  } else if (sub && sub !== 'show') fail(`unknown: mdt env ${sub}`);
  const env = Object.entries(cfg.buildEnv);
  console.log(env.length ? env.map(([k, v]) => `${k}=${v}`).join('\n') : '(no build env)');
}

// ================================================================ framework

function cmdFramework(cfg, {pos, opt}) {
  const sub = pos[0] || 'status';
  const prof = profileOf(cfg, opt);
  if (sub === 'extract') {
    const packages = opt.packages ? String(opt.packages).split(',') : prof.packages || DEFAULT_PACKAGES;
    if (opt.force && fw.manifest(prof.name) && fw.patchState(prof.name) === 'unsaved') fail('unsaved framework edits: mdt framework save first');
    setupFramework(cfg, prof, packages, {force: !!opt.force});
    cfg.profiles[prof.name].packages = [...new Set([...(prof.packages || []), ...packages])];
    saveCfg(cfg);
    return;
  }
  if (!fw.manifest(prof.name)) fail(`framework for ${prof.name} not extracted: mdt framework extract`);
  const st = fw.status(prof.name);
  const state = fw.patchState(prof.name);

  if (sub === 'status') {
    console.log(`framework/${prof.name}  (maximo-js-api ${prof.tools?.['maximo-js-api'] || '?'}, packages: ${Object.keys(fw.manifest(prof.name).packages).join(', ')})`);
    for (const f of st.changed) console.log(`  ${c.yellow('M')} ${f}`);
    for (const f of st.added) console.log(`  ${c.green('A')} ${f}`);
    for (const f of st.deleted) console.log(`  ${c.red('D')} ${f} ${c.dim('(ignored at build: IBM file stays)')}`);
    for (const f of st.rejects) console.log(`  ${c.red('!')} ${f} ${c.dim('(rejected hunk: fix the file, delete this, mdt framework save)')}`);
    if (!fw.editCount(st) && !st.deleted.length) console.log('  no edits');
    const msg = {
      none: 'no patch',
      saved: 'patches/framework.patch is up to date',
      unsaved: 'edits differ from patches/framework.patch: run mdt framework save',
      'not-loaded': 'patches/framework.patch has edits not in this working copy: run mdt framework load'
    }[state];
    console.log(`  ${state === 'unsaved' || state === 'not-loaded' ? c.yellow(msg) : c.dim(msg)}`);
    return;
  }
  if (sub === 'diff') {
    const patch = fw.diff(prof.name);
    if (opt.out) {
      fs.writeFileSync(path.resolve(opt.out), patch);
      return ok(`wrote ${opt.out}`);
    }
    return process.stdout.write(patch || '(no edits)\n');
  }
  if (sub === 'save') {
    if (st.rejects.length) fail(`resolve and delete the reject files first: ${st.rejects.join(', ')}`);
    if (state === 'not-loaded' && !opt.force) fail('the working copy has no edits but patches/framework.patch does: saving would erase it (mdt framework load, or --force)');
    const r = fw.save(prof.name);
    return ok(`patches/framework.patch: ${r.files} file(s) (commit it to keep your framework changes)`);
  }
  if (sub === 'load' || sub === 'reset') {
    if (state === 'unsaved' && fw.editCount(st) && !opt.force) fail(`framework/${prof.name} has unsaved edits that ${sub} would discard (mdt framework save, or --force)`);
    if (sub === 'reset') {
      fw.reset(prof.name);
      return ok(`framework/${prof.name} reset to IBM's sources`);
    }
    const r = fw.load(prof.name);
    if (r.empty) return info('no patches/framework.patch: working copy is now IBM baseline');
    if (!r.ok) warn(`resolve the *.rej files under framework/${prof.name}, then mdt framework save`);
    return;
  }
  if (sub === 'apply') {
    const f = path.resolve(pos[1] || '');
    if (!fs.existsSync(f)) fail('usage: mdt framework apply <file.patch>');
    const r = fw.apply(prof.name, f);
    if (r.ok) ok(`applied ${path.basename(f)} to framework/${prof.name} (mdt framework save to keep it)`);
    return;
  }
  fail(`unknown: mdt framework ${sub}`);
}

// ================================================================ build / package / upload

function buildApp(cfg, appRef, opt) {
  const prof = profileOf(cfg, opt);
  const app = appOf(cfg, appRef);
  const src = abs(app.src);
  const ai = readAppInfo(src);
  if (!ai) fail(`${app.src} has no src/app.xml`);
  const out = P.out(prof.name, app.id);
  const haveFw = !!fw.manifest(prof.name);
  const useFw = haveFw && !opt['no-framework'];
  const st = haveFw ? fw.status(prof.name) : {changed: [], added: []};
  if (useFw) {
    const state = fw.patchState(prof.name);
    if (state === 'not-loaded') warn('patches/framework.patch is not loaded in this working copy (mdt framework load)');
    if (state === 'unsaved') info(c.yellow('building with framework edits that are not saved to patches/framework.patch'));
  }
  info(`build ${c.bold(app.id)} ${ai.version} with ${prof.name} (${opt.debug ? 'debug' : 'release'}, framework: ${useFw ? `${fw.editCount(st)} edit(s)` : 'stock'})`);
  const mounts = [
    [src, '/src', 'ro'],
    [TOOL_DIR, '/mdt', 'ro'],
    [out, '/out']
  ];
  if (useFw) mounts.push([P.framework(prof.name), '/framework', 'ro'], [P.baseline(prof.name), '/baseline', 'ro']);
  // VITE_*/REACT_APP_* end up in the app's process.env; the MAS pod sets
  // VITE_ROUTING_MODE, VITE_MAS_DOMAIN, VITE_ROOT_PATH (mdt env detect copies them)
  const env = Object.fromEntries(Object.entries({...cfg.buildEnv, ...(prof.buildEnv || {})}).filter(([k]) => /^(VITE_|REACT_APP_|GRAPHITE_)/.test(k)));
  const t0 = Date.now();
  const r = containerRun(cfg, prof.image, mounts, {...env, MDT_DEBUG: opt.debug ? '1' : '0', MDT_FRAMEWORK: useFw ? '1' : '0'}, containerScript('build-app.sh'));
  if (r.status !== 0) fail(`build failed (exit ${r.status})`);
  const meta = readJson(path.join(out, 'mdt-build.json'));
  if (!meta) fail('build finished without mdt-build.json');
  const git = args => capture('git', ['-C', src, ...args], {allowFail: true}).stdout?.trim() || null;
  Object.assign(meta, {
    profile: prof.name,
    image: prof.image,
    tools: prof.tools,
    app: {id: app.id, masId: ai.masId, title: ai.title, platform: ai.platform, source: app.src, commit: git(['rev-parse', '--short', 'HEAD']), dirty: !!git(['status', '--porcelain'])},
    buildEnv: env,
    patchState: useFw ? fw.patchState(prof.name) : 'stock',
    patchSha: useFw ? fw.patchFileSha() : null
  });
  fs.writeFileSync(path.join(out, 'mdt-build.json'), JSON.stringify(meta, null, 1));
  ok(`built ${rel(path.join(out, meta.zip))} in ${Math.round((Date.now() - t0) / 1000)}s`);
  return {prof, app, out, meta};
}

function cmdPackage(cfg, appRef, opt) {
  const prof = profileOf(cfg, opt);
  if (fw.manifest(prof.name) && !opt['no-framework']) {
    const state = fw.patchState(prof.name);
    if ((state === 'unsaved' || state === 'not-loaded') && !opt['allow-unsaved']) {
      fail(`framework working copy and patches/framework.patch differ (${state}); save or load first so the release is reproducible (or --allow-unsaved)`);
    }
  }
  const {app, out, meta} = buildApp(cfg, appRef, {...opt, debug: false});
  const dir = path.join(P.dist, app.id, `${meta.version}-${stamp()}`);
  fs.mkdirSync(dir, {recursive: true});
  const artifacts = {};
  for (const f of [meta.zip, `${meta.appId}.zip`, 'app-source.zip']) {
    fs.copyFileSync(path.join(out, f), path.join(dir, f));
    artifacts[f] = sha256File(path.join(dir, f));
  }
  if (meta.patchSha && fs.existsSync(P.frameworkPatch)) fs.copyFileSync(P.frameworkPatch, path.join(dir, 'framework.patch'));
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({...meta, artifacts, packagedAt: new Date().toISOString()}, null, 1));
  console.log(`\n${c.bold(rel(dir))}`);
  console.log(`  ${meta.zip.padEnd(34)} app binary for Maximo: mdt upload ${app.id} --target <name>`);
  console.log(`  ${`${meta.appId}.zip`.padEnd(34)} sources for the MAS Configuration app (Upload), rebuilt there`);
  console.log(`  ${'app-source.zip'.padEnd(34)} raw source archive (the one inside the binary)`);
  console.log(`  ${'release.json'.padEnd(34)} versions, image, framework patch, git commit, sha256`);
  console.log(`Test this exact build on the device: mdt push ${app.id}`);
  return dir;
}

function latestRelease(appId, which) {
  if (which && which !== true && which !== 'latest') {
    const d = path.resolve(which);
    if (!fs.existsSync(path.join(d, 'release.json'))) fail(`${d} is not a release folder (no release.json)`);
    return d;
  }
  const base = path.join(P.dist, appId);
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).map(d => path.join(base, d)).filter(d => fs.existsSync(path.join(d, 'release.json'))) : [];
  if (!dirs.length) fail(`no packaged release for ${appId}: mdt package ${appId}`);
  return dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

async function cmdUpload(cfg, appRef, opt) {
  const app = appOf(cfg, appRef);
  const t = loadTarget(opt.target);
  const dir = latestRelease(app.id, opt.release);
  const rj = readJson(path.join(dir, 'release.json'));
  const zip = path.join(dir, rj.zip);
  if (sha256File(zip) !== rj.artifacts[rj.zip]) fail(`${rj.zip} does not match release.json (modified?)`);
  if (rj.debug) fail('refusing to upload a debug build');
  console.log(`release ${rel(dir)}: ${rj.appId} ${rj.version}, ${rj.profile}, framework ${rj.framework ? `${rj.framework.changed.length + rj.framework.added.length} file(s)` : 'stock'}, source ${rj.app?.commit || '?'}${rj.app?.dirty ? ' (dirty)' : ''}`);
  console.log(`target  ${describeTarget(t)}`);
  if (!opt.yes && !opt['dry-run']) await confirm(`Upload ${rj.appId} ${rj.version} to ${t.name}? Type the app id to confirm:`, rj.appId);
  uploadZip(t, {appId: rj.appId, masId: rj.app?.masId, version: rj.version, description: rj.app?.title}, zip, {dryRun: !!opt['dry-run']});
  if (!opt['dry-run']) {
    const log = path.join(dir, 'uploads.log');
    fs.appendFileSync(log, `${new Date().toISOString()} ${t.name} ${t.domain}\n`);
    console.log('Devices pick the new version up on their next app update check / login.');
  }
}

// ================================================================ device

function buildFor(cfg, appRef, opt) {
  const prof = profileOf(cfg, opt);
  const app = appOf(cfg, appRef);
  if (opt.release) {
    const dir = latestRelease(app.id, opt.release);
    const rj = readJson(path.join(dir, 'release.json'));
    const idx = path.join(P.tmp, `${app.id}-index.html`);
    fs.mkdirSync(P.tmp, {recursive: true});
    fs.writeFileSync(idx, capture(tarExe(), ['-xOf', path.join(dir, rj.zip), 'index.html'], {binary: true}).stdout);
    return {app, meta: rj, zip: path.join(dir, rj.zip), index: idx, from: rel(dir)};
  }
  const out = P.out(prof.name, app.id);
  const meta = readJson(path.join(out, 'mdt-build.json'));
  if (!meta) fail(`no build for ${app.id} in profile ${prof.name}: mdt build ${app.id}`);
  return {app, meta, zip: path.join(out, meta.zip), index: path.join(out, 'www', 'index.html'), from: rel(out)};
}

async function cmdPush(cfg, appRef, opt) {
  const b = buildFor(cfg, appRef, opt);
  const dir = `files/www/apps/${b.app.id}`;
  const steps = [
    opt['no-backup'] ? null : `backup   ${dir} -> .mdt/backups/${b.app.id}/<time>.tar`,
    `upload   ${b.meta.zip} -> <sandbox>/cache/`,
    opt['keep-old-assets'] ? null : `clean    ${dir}/assets (everything there comes from the build)`,
    `unzip    into ${dir} (merge: the shell's cordova.js, cordova_plugins.js, plugins/ stay)`,
    'verify   index.html sha256 on the device == local',
    opt['no-reload'] ? null : opt.restart ? 'restart  Maximo Mobile' : `reload   ${b.app.id} inside Navigator via DevTools`
  ].filter(Boolean);
  console.log(`push ${b.app.id} ${b.meta.version} (${b.meta.debug ? 'debug' : 'release'}, ${b.from}) to ${cfg.device.package}:`);
  steps.forEach(s => console.log(`  ${s}`));
  if (opt['dry-run']) return;
  const dev = new Device(cfg, opt).ensure();
  if (!dev.listApps().includes(b.app.id)) fail(`${b.app.id} is not on the device yet: log in once so Maximo Mobile downloads it (push replaces an installed app)`);
  const onDevice = dev.readBuildJson(b.app.id);
  if (onDevice?.version && onDevice.version !== b.meta.buildJsonVersion && onDevice.version !== b.meta.version) warn(`device has ${onDevice.version}, pushing ${b.meta.version}`);
  if (!opt['no-backup']) backup(dev, b.app.id);
  pushBundle(dev, b.app.id, b.zip, b.index, {keepOldAssets: !!opt['keep-old-assets']});
  ok(`pushed ${b.app.id} ${b.meta.version}`);
  if (!opt['no-reload']) await reload(dev, b.app.id, {restart: !!opt.restart});
}

async function cmdRestore(cfg, appRef, file, opt) {
  const appId = String(appRef || '').toLowerCase();
  const dir = P.backups(appId);
  const tars = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.tar')).sort() : [];
  const tar = file ? path.resolve(file) : tars.length ? path.join(dir, tars[0]) : null;
  if (!tar || !fs.existsSync(tar)) fail(`no backup for ${appId} in ${rel(dir)}`);
  if (!file) warn(`restoring the OLDEST backup (closest to what the server delivered): ${rel(tar)}`);
  if (opt['dry-run']) return;
  const dev = new Device(cfg, opt).ensure();
  restoreBackup(dev, appId, tar);
  if (!opt['no-reload']) await reload(dev, appId, {restart: !!opt.restart});
}

// ================================================================ main

const HELP = `mdt - Maximo Mobile dev toolkit   (workspace ${ROOT})

setup
  init                        set up / refresh: images/*.tar -> profiles, apps/* -> apps, device env
  doctor                      check node, podman, git, curl, adb, device
  status                      profiles, apps, build env, targets
  image add <tar> [--name N] | image use <profile> | image remove <profile> [--rmi]
  app add <folder> [--as id] | app remove <id> | app import <appId> [--to Folder]
  env | env detect [app] | env set VITE_X=... | env unset VITE_X

framework   (edit framework/<profile>/<package>/..., keep edits in patches/framework.patch)
  framework status            edits vs IBM baseline, patch state
  framework save              working copy -> patches/framework.patch (commit it)
  framework load              IBM baseline + patches/framework.patch -> working copy
  framework reset             working copy -> IBM baseline
  framework diff [--out f]  | framework apply <f.patch> | framework extract [--packages a,b]

build & device   (device commands need a debuggable Maximo Mobile APK)
  build <app> [--debug] [--no-framework]
  device                      APK + installed app versions (read-only)
  backup <app>                copy the app bundle from the device (read-only)
  push <app> [--release [dir]] [--dry-run] [--no-backup] [--no-reload] [--restart] [--keep-old-assets]
  deploy <app> [--debug]      build + push
  reload [app] [--restart]    reload the app in Navigator, or restart the APK
  restore <app> [backup.tar]  default: oldest backup

release
  package <app>               release build -> dist/<app>/<version>-<time>/ (binary, source zips, release.json)
  upload <app> --target T [--release dir] [--dry-run] [--yes]   send the packaged binary to Maximo
  publish <app> --target T    package + upload
  image build [--tag T] [--save [file.tar]]   bake patches/framework.patch into a new image

options: --profile <name> (default: active)  --serial <adb serial>
`;

const VALUE_OPTS = new Set(['profile', 'packages', 'name', 'id', 'tag', 'save', 'out', 'target', 'release', 'serial', 'as', 'to']);

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (v !== undefined) opt[k] = v;
      else if (VALUE_OPTS.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return {pos, opt};
}

async function main() {
  const {pos, opt} = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  const cfg = loadCfg();
  const a = {pos: rest, opt};
  switch (cmd) {
    case 'init':
      return cmdInit(cfg, a);
    case 'doctor':
      return void doctor(cfg);
    case 'status':
      return cmdStatus(cfg);
    case 'image':
      return cmdImage(cfg, a);
    case 'app':
      return cmdApp(cfg, a);
    case 'env':
      return cmdEnv(cfg, a);
    case 'framework':
    case 'fw':
      return cmdFramework(cfg, a);
    case 'build':
      return void buildApp(cfg, rest[0], opt);
    case 'package':
      return void cmdPackage(cfg, rest[0], opt);
    case 'upload':
      return cmdUpload(cfg, rest[0], opt);
    case 'publish': {
      loadTarget(opt.target); // fail before building if the target is wrong
      const dir = cmdPackage(cfg, rest[0], opt);
      return cmdUpload(cfg, rest[0], {...opt, release: dir});
    }
    case 'device':
      return printDevice(new Device(cfg, opt));
    case 'backup': {
      const dev = new Device(cfg, opt).ensure();
      const appId = String(rest[0] || '').toLowerCase();
      if (!dev.listApps().includes(appId)) fail(`${appId || '<app>'} is not installed on the device`);
      return void backup(dev, appId);
    }
    case 'push':
      return cmdPush(cfg, rest[0], opt);
    case 'deploy':
      buildApp(cfg, rest[0], opt);
      return cmdPush(cfg, rest[0], opt);
    case 'reload':
      return reload(new Device(cfg, opt).ensure(), String(rest[0] || 'navigator').toLowerCase(), {restart: !!opt.restart});
    case 'restore':
      return cmdRestore(cfg, rest[0], rest[1], opt);
    default:
      process.stdout.write(HELP);
  }
}

main().catch(e => {
  if (e instanceof MdtError) console.error(c.red(`[mdt] ${e.message}`));
  else console.error(e);
  process.exit(1);
});
