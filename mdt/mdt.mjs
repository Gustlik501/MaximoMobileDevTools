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
import * as proj from './lib/project.mjs';
import {containerRun, containerScript, engine, engineStatus} from './lib/container.mjs';
import {Device, backup, detectAdb, detectBuildEnv, printDevice, pushBundle, reload, restoreBackup} from './lib/device.mjs';
import {describeTarget, loadTarget, uploadZip} from './lib/upload.mjs';
import * as drive from './lib/drive.mjs';
import {LEVELS, POLICY_FILES, classifyMdt, decide, loadPolicy, writeLocalPolicy} from './lib/policy.mjs';
import {
  APP_ID_RE,
  MdtError,
  P,
  ROOT,
  TOOL_DIR,
  appOf,
  c,
  capture,
  confirm,
  fail,
  git,
  info,
  listApps,
  loadCfg,
  ok,
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

const HOOK_HINT = 'Claude Code hook NOT installed: copy mdt/agent/claude-settings.json to .claude/settings.json (then commit it)';
function hookInstalled() {
  const f = path.join(ROOT, '.claude', 'settings.json');
  return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('policy-hook.mjs');
}

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
  const g = spawnSync('git', ['--version'], {encoding: 'utf8'});
  add('git', g.status === 0, (g.stdout || 'missing').trim());
  add('repo', proj.isGitRepo(), proj.isGitRepo() ? 'git repository' : 'not a git repository (upgrades need one: git init)');
  const curl = spawnSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe') : 'curl', ['--version'], {encoding: 'utf8'});
  add('curl', curl.status === 0, (curl.stdout || 'missing').split('\n')[0].trim());
  const adb = (cfg.device.adb && fs.existsSync(cfg.device.adb) && cfg.device.adb) || detectAdb();
  add('adb', !!adb, adb || 'not found (only needed for device commands)');
  if (adb) {
    const devs = new Device({...cfg, device: {...cfg.device, adb}}).devices();
    add('device', devs.length > 0, devs.length ? devs.join(', ') : 'none connected');
  }
  add('policy', hookInstalled(), hookInstalled() ? 'Claude Code hook installed' : HOOK_HINT);
  if (!quiet) for (const r of rows) console.log(`  ${r.good ? c.green('ok ') : c.yellow('-- ')} ${r.name.padEnd(7)} ${r.detail}`);
  if (major < 22) fail('Node 22 or newer is required');
  return {adb, engineOk: es.ok};
}

async function cmdInit(cfg, {opt}) {
  console.log(c.bold(`mdt project: ${ROOT}`));
  const d = doctor(cfg);
  for (const dir of [P.fwOotb, P.fwCust, P.appsOotb, P.appsCust, P.images, P.patches, P.targets, P.dist, P.state]) fs.mkdirSync(dir, {recursive: true});
  if (d.adb) cfg.device.adb = d.adb;

  if (!d.engineOk) warn('container engine not ready: skipping the image');
  else if (!proj.fwMeta()) {
    if (proj.imageTars().length) proj.importFrameworkOotb(cfg, null, opt.packages ? {packages: String(opt.packages).split(',')} : {});
    else warn('no image yet: copy the graphite-configuration .tar into images/ and run mdt init again');
  } else {
    try {
      proj.ensureImage(cfg, proj.fwMeta().image);
    } catch (e) {
      warn(e.message);
    }
  }

  if (d.adb && !Object.keys(cfg.buildEnv).length) {
    try {
      const det = detectBuildEnv(new Device(cfg, opt).ensure());
      if (det) {
        cfg.buildEnv = det.env;
        info(`build env from ${det.appId} on the device: ${Object.entries(det.env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      }
    } catch (e) {
      info(`build env not read from a device (${e.message.split('\n')[0]}); set it with mdt env set if needed`);
    }
  }
  saveCfg(cfg);
  console.log('');
  cmdStatus(cfg);
}

function cmdStatus(cfg) {
  const meta = proj.fwMeta();
  console.log(c.bold('Framework'));
  if (!meta) console.log('  no OOTB yet: put the graphite-configuration tar into images/ and run mdt init');
  else {
    const cmp = proj.compareTree(proj.trees()[0]);
    console.log(`  OOTB        graphite-configuration ${meta.version}-${meta.release} (image ${meta.image.slice(0, 12)}), maximo-js-api ${meta.tools?.['maximo-js-api']}, ${meta.packages.join(', ')}`);
    console.log(`  CUSTOMIZED  ${cmp.changed.length} changed, ${cmp.added.length} added, ${cmp.deleted.length} removed vs OOTB`);
  }
  console.log(c.bold('MobileApps'));
  const apps = Object.values(listApps());
  if (!apps.length) console.log('  none: mdt ootb app <MAF Configuration download> (creates OOTB + CUSTOMIZED)');
  for (const a of apps) {
    const t = proj.trees().find(x => x.name === a.id);
    const cmp = a.ootb && a.cust ? proj.compareTree(t) : null;
    console.log(
      `  ${a.id.padEnd(14)} ${a.folder.padEnd(14)} OOTB ${String(a.ootb?.info.version || c.yellow('missing')).padEnd(10)} CUSTOMIZED ${String(a.cust?.info.version || c.yellow('missing')).padEnd(10)}${cmp ? ` ${cmp.changed.length + cmp.added.length + cmp.deleted.length} file(s) customized` : ''}`
    );
  }
  const pending = proj.upgradePending();
  if (pending) console.log(c.yellow(`\n${pending}`));
  const st = readJson(path.join(P.upgrades, 'state.json'));
  const first = proj.pendingOotb('HEAD').filter(p => p.initial);
  if (first.length) console.log(c.yellow(`\nfirst OOTB import not committed yet (${[...new Set(first.map(p => p.root))].join(', ')}): git add -A && git commit`));
  if (st && !pending && proj.pendingOotb('HEAD').some(p => !p.initial)) console.log(c.yellow(`\nupgrade merged, not committed yet (report: ${st.report})`));
  const conflicts = proj.conflictFiles([P.fwCust, P.appsCust]);
  if (conflicts.length) console.log(c.red(`\nunresolved conflict markers in ${conflicts.length} file(s):\n  ${conflicts.slice(0, 20).join('\n  ')}`));
  console.log(c.bold('\nbuild env'));
  const env = Object.entries(cfg.buildEnv);
  console.log(env.length ? env.map(([k, v]) => `  ${k}=${v}`).join('\n') : '  (none: mdt env detect | mdt env set VITE_MAS_DOMAIN=...)');
  const targets = fs.existsSync(P.targets) ? fs.readdirSync(P.targets).filter(f => f.endsWith('.json') && f !== 'example.json') : [];
  console.log(c.bold('upload targets'));
  console.log(targets.length ? `  ${targets.map(f => f.replace(/\.json$/, '')).join(', ')}` : '  none (copy targets/example.json)');
  const pol = loadPolicy().policy;
  console.log(c.bold('agent policy') + `  ${Object.entries(pol).map(([k, v]) => `${k}=${v}`).join(' ')}${hookInstalled() ? '' : c.yellow('  (hook not installed)')}`);
}

function cmdEnv(cfg, {pos, opt}) {
  const sub = pos[0];
  if (sub === 'detect') {
    const det = detectBuildEnv(new Device(cfg, opt).ensure(), pos[1]);
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

// ================================================================ OOTB, diff, upgrade

function cmdOotb(cfg, {pos, opt}) {
  const sub = pos[0];
  if (sub === 'framework') {
    proj.importFrameworkOotb(cfg, pos[1], opt.packages ? {packages: String(opt.packages).split(',')} : {});
    saveCfg(cfg);
    return afterOotb();
  }
  if (sub === 'app') {
    const r = proj.importAppOotb(pos[1], {as: opt.as});
    ok(`MobileApps/OOTB/${r.folder} = ${r.ai.id} ${r.ai.version}`);
    for (const w of r.warnings) warn(`not pristine? ${w}`);
    if (r.created) info(`MobileApps/CUSTOMIZED/${r.folder} created as a copy of OOTB`);
    return afterOotb();
  }
  fail('usage: mdt ootb framework [image.tar] [--packages a,b] | mdt ootb app <download.zip|folder> [--as FOLDER]');
}

function afterOotb() {
  if (proj.upgradePending()) info('OOTB differs from the last commit: run mdt upgrade --dry-run, then mdt upgrade');
  else if (proj.pendingOotb('HEAD').some(p => p.initial)) info('first import: commit it (git add -A && git commit) as the project\'s starting point');
}

function cmdDiff(cfg, {pos, opt}) {
  const want = pos[0] ? String(pos[0]).toLowerCase() : null;
  const list = proj.trees().filter(t => !want || t.name === want || t.folder?.toLowerCase() === want);
  if (!list.length) fail(`unknown: ${pos[0]} (framework or an app id)`);
  fs.mkdirSync(P.patches, {recursive: true});
  for (const t of list) {
    if (!fs.existsSync(t.ootb) || !fs.existsSync(t.cust)) {
      warn(`${t.label}: OOTB or CUSTOMIZED missing`);
      continue;
    }
    const {patch, cmp} = proj.patchOf(t);
    const n = cmp.changed.length + cmp.added.length + cmp.deleted.length;
    const file = path.join(P.patches, `${t.name}.patch`);
    if (!opt['no-save']) fs.writeFileSync(file, patch);
    console.log(`${c.bold(t.label.padEnd(24))} ${String(n).padStart(4)} file(s): ${cmp.changed.length} changed, ${cmp.added.length} added, ${cmp.deleted.length} removed${opt['no-save'] ? '' : `  -> ${rel(file)}`}`);
    if (opt.stat || opt.files) {
      for (const f of cmp.changed) console.log(`    M ${f}`);
      for (const f of cmp.added) console.log(`    A ${f}`);
      for (const f of cmp.deleted) console.log(`    D ${f}`);
    }
  }
}

function cmdUpgrade(cfg, {opt}) {
  const {results, runDir} = proj.upgrade(cfg, {base: opt.base || 'HEAD', dryRun: !!opt['dry-run'], force: !!opt.force});
  const count = a => results.filter(r => r.action === a).length;
  console.log(`\n${opt['dry-run'] ? c.bold('dry run: nothing written') : c.bold('merged into CUSTOMIZED')}`);
  const rows = [
    ['took IBM\'s new version', count('took-ibm')],
    ['merged cleanly (both changed)', count('merged')],
    ['added by IBM', count('added')],
    ['deleted by IBM', count('deleted')],
    ['kept yours', count('kept-yours')],
    ['to review', count('review')],
    ['CONFLICTS', count('conflict')]
  ];
  for (const [l, n] of rows) if (n) console.log(`  ${String(n).padStart(4)}  ${l}`);
  for (const r of results.filter(x => x.action === 'conflict' || x.action === 'review')) console.log(`        ${r.action === 'conflict' ? c.red('C') : c.yellow('?')} ${r.file}${r.note ? c.dim(`  ${r.note}`) : ''}`);
  console.log(`report: ${rel(path.join(runDir, 'REPORT.md'))}`);
  if (!opt['dry-run']) {
    const meta = proj.fwMeta();
    console.log(`\nNext: resolve conflicts (search for <<<<<<<), mdt build <app> --debug, test, then\n  git add -A && git commit -m "Upgrade to ${meta ? `graphite-configuration ${meta.version}` : 'new IBM release'}"${meta ? ` && git tag ootb-${meta.version}` : ''}`);
  }
}

// ================================================================ build / package / upload

function buildApp(cfg, appRef, opt) {
  const meta = proj.buildImage(cfg);
  const app = appOf(appRef);
  if (!app.cust) fail(`MobileApps/CUSTOMIZED/${app.folder} is missing`);
  const pending = proj.upgradePending();
  if (pending) fail(pending);
  const marks = proj.conflictFiles([app.cust.dir, P.fwCust]);
  if (marks.length) fail(`unresolved conflict markers:\n  ${marks.join('\n  ')}`);
  const out = P.out(app.id);
  const useFw = !opt['no-framework'] && fs.existsSync(P.fwCust) && fs.existsSync(P.fwOotb);
  const fwCmp = useFw ? proj.compareTree(proj.trees()[0]) : null;
  info(
    `build ${c.bold(app.id)} ${app.cust.info.version} on graphite-configuration ${meta.version} (${opt.debug ? 'debug' : 'release'}, framework: ${useFw ? `${fwCmp.changed.length + fwCmp.added.length} customized file(s)` : 'stock'})`
  );
  const mounts = [
    [app.cust.dir, '/src', 'ro'],
    [TOOL_DIR, '/mdt', 'ro'],
    [out, '/out']
  ];
  if (useFw) mounts.push([P.fwCust, '/framework', 'ro'], [P.fwOotb, '/ootb', 'ro']);
  // VITE_*/REACT_APP_* end up in the app's process.env; the MAS pod sets
  // VITE_ROUTING_MODE, VITE_MAS_DOMAIN, VITE_ROOT_PATH (mdt env detect copies them)
  const env = Object.fromEntries(Object.entries(cfg.buildEnv || {}).filter(([k]) => /^(VITE_|REACT_APP_|GRAPHITE_)/.test(k)));
  const t0 = Date.now();
  const r = containerRun(
    cfg,
    meta.image,
    mounts,
    {...env, MDT_DEBUG: opt.debug ? '1' : '0', MDT_FRAMEWORK: useFw ? '1' : '0', MDT_TEST_HOOK: opt['no-test-hook'] ? '0' : '1'},
    containerScript('build-app.sh')
  );
  if (r.status !== 0) fail(`build failed (exit ${r.status})`);
  const bm = readJson(path.join(out, 'mdt-build.json')) || fail('build finished without mdt-build.json');
  const gitv = args => (proj.isGitRepo() ? git(args, {allowFail: true}).stdout?.trim() || null : null);
  const custRel = rel(app.cust.dir);
  Object.assign(bm, {
    image: meta.image,
    ootb: {framework: `${meta.version}-${meta.release}`, frameworkTools: meta.tools, app: app.ootb?.info.version || null},
    app: {id: app.id, folder: app.folder, masId: app.cust.info.masId, title: app.cust.info.title, platform: app.cust.info.platform},
    commit: gitv(['rev-parse', '--short', 'HEAD']),
    dirty: !!gitv(['status', '--porcelain', '--', custRel, 'Framework/CUSTOMIZED']),
    buildEnv: env
  });
  fs.writeFileSync(path.join(out, 'mdt-build.json'), JSON.stringify(bm, null, 1));
  ok(`built ${rel(path.join(out, bm.zip))} in ${Math.round((Date.now() - t0) / 1000)}s`);
  return {app, out, meta: bm};
}

function cmdPackage(cfg, appRef, opt) {
  const {app, out, meta} = buildApp(cfg, appRef, {...opt, debug: false});
  if (meta.dirty) warn('CUSTOMIZED has uncommitted changes: release.json records the commit plus "dirty"');
  const dir = path.join(P.dist, app.id, `${meta.version}-${stamp()}`);
  fs.mkdirSync(dir, {recursive: true});
  const artifacts = {};
  const cfgZip = meta.configZip || `${meta.appId.toUpperCase()}.zip`;
  for (const f of [meta.zip, cfgZip, 'app-source.zip']) {
    fs.copyFileSync(path.join(out, f), path.join(dir, f));
    artifacts[f] = sha256File(path.join(dir, f));
  }
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({...meta, artifacts, packagedAt: new Date().toISOString()}, null, 1));
  console.log(`\n${c.bold(rel(dir))}`);
  console.log(`  ${meta.zip.padEnd(34)} app binary for Maximo: mdt upload ${app.id} --target <name>`);
  console.log(`  ${cfgZip.padEnd(34)} sources for the MAS Configuration app (Upload), rebuilt there`);
  console.log(`  ${'app-source.zip'.padEnd(34)} raw source archive (the one inside the binary)`);
  console.log(`  ${'release.json'.padEnd(34)} versions, image, git commit, sha256`);
  console.log(`Test this exact build on the device: mdt push ${app.id} --release`);
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
  const app = appOf(appRef);
  const t = loadTarget(opt.target);
  const dir = latestRelease(app.id, opt.release);
  const rj = readJson(path.join(dir, 'release.json'));
  const zip = path.join(dir, rj.zip);
  if (sha256File(zip) !== rj.artifacts[rj.zip]) fail(`${rj.zip} does not match release.json (modified?)`);
  if (rj.debug) fail('refusing to upload a debug build');
  console.log(`release ${rel(dir)}: ${rj.appId} ${rj.version}, framework OOTB ${rj.ootb?.framework}, ${rj.framework ? `${rj.framework.changed.length + rj.framework.added.length} customized framework file(s)` : 'stock framework'}, commit ${rj.commit || '?'}${rj.dirty ? ' (dirty)' : ''}`);
  console.log(`target  ${describeTarget(t)}`);
  if (!opt.yes && !opt['dry-run']) await confirm(`Upload ${rj.appId} ${rj.version} to ${t.name}? Type the app id to confirm:`, rj.appId);
  uploadZip(t, {appId: rj.appId, masId: rj.app?.masId, version: rj.version, description: rj.app?.title}, zip, {dryRun: !!opt['dry-run']});
  if (!opt['dry-run']) {
    fs.appendFileSync(path.join(dir, 'uploads.log'), `${new Date().toISOString()} ${t.name} ${t.domain}\n`);
    console.log('Devices pick the new version up on their next app update check / login.');
  }
}

// Bake Framework/CUSTOMIZED (its difference to OOTB) into a new image.
function cmdImageBuild(cfg, opt) {
  const meta = proj.buildImage(cfg);
  const cmp = proj.compareTree(proj.trees()[0]);
  if (!cmp.changed.length && !cmp.added.length) fail('Framework/CUSTOMIZED has no changes vs OOTB: nothing to bake');
  const marks = proj.conflictFiles([P.fwCust]);
  if (marks.length) fail(`unresolved conflict markers:\n  ${marks.join('\n  ')}`);
  const ctx = path.join(P.state, 'image-build');
  fs.rmSync(ctx, {recursive: true, force: true});
  fs.mkdirSync(path.join(ctx, 'overlay'), {recursive: true});
  info(`compiling ${cmp.changed.length + cmp.added.length} framework file(s) with the image's Babel ...`);
  const r = containerRun(
    cfg,
    meta.image,
    [
      [TOOL_DIR, '/mdt', 'ro'],
      [P.fwCust, '/framework', 'ro'],
      [P.fwOotb, '/ootb', 'ro'],
      [ctx, '/out']
    ],
    {},
    'node /mdt/container/compile-framework.cjs --framework /framework --ootb /ootb --overlay /out/overlay --report /out/framework-report.json'
  );
  if (r.status !== 0) fail('framework compile failed');
  const report = readJson(path.join(ctx, 'framework-report.json'));
  const files = [...walk(path.join(ctx, 'overlay'))];
  const staleMaps = files.filter(f => f.endsWith('.js')).map(f => `/graphite/node_modules/@maximo/${f}.map`);
  const commit = proj.isGitRepo() ? git(['rev-parse', '--short', 'HEAD'], {allowFail: true}).stdout.trim() : '';
  const tag = opt.tag || `localhost/mdt/graphite-configuration:${meta.version}-mdt.${stamp()}`;
  const lines = [
    '# generated by mdt image build',
    `FROM ${meta.image}`,
    'USER root',
    'COPY --chown=wiotp:root overlay/ /graphite/node_modules/@maximo/',
    // IBM's external .map files no longer match the patched files (ours carry inline maps)
    ...(staleMaps.length ? [`RUN rm -f ${staleMaps.join(' ')}`] : []),
    `LABEL mdt.base-image="${meta.image}" mdt.framework-files="${report.changed.length + report.added.length}" mdt.commit="${commit}"`,
    'USER wiotp',
    ''
  ];
  fs.writeFileSync(path.join(ctx, 'Containerfile'), lines.join('\n'));
  fs.writeFileSync(path.join(ctx, 'CHANGES.txt'), [...report.changed.map(f => `M ${f}`), ...report.added.map(f => `A ${f}`)].join('\n') + '\n');
  info(`building ${tag}`);
  run(engine(cfg), ['build', '-t', tag, '-f', path.join(ctx, 'Containerfile'), ctx]);
  const inImage = files.map(f => `/graphite/node_modules/@maximo/${f}`);
  const v = capture(engine(cfg), ['run', '--rm', tag, 'sha256sum', ...inImage]).stdout;
  const want = Object.fromEntries(files.map(f => [`/graphite/node_modules/@maximo/${f}`, sha256File(path.join(ctx, 'overlay', f))]));
  const bad = v.split(/\r?\n/).filter(Boolean).map(l => l.split(/\s+/)).filter(([h, f]) => want[f] !== h);
  if (bad.length) fail(`image verification failed for: ${bad.map(b => b[1]).join(', ')}`);
  ok(`verified ${files.length} file(s) in ${tag}`);
  if (opt.save) {
    const saved = path.resolve(opt.save === true ? path.join(P.dist, 'images', `graphite-configuration-${meta.version}-mdt-${stamp()}.tar`) : opt.save);
    fs.mkdirSync(path.dirname(saved), {recursive: true});
    info(`saving ${rel(saved)} (docker-archive, same format as IBM's tar) ...`);
    run(engine(cfg), ['save', '--format', 'docker-archive', '-o', saved, tag]);
  }
  console.log(`\nBuild context: ${rel(ctx)}\nNext: push ${tag} to your registry and point the graphite-configuration deployment at it (README: "Shipping to production").`);
}

// ================================================================ device

// Every bundle on the device carries app-source.zip (the full project).
function cmdAppImport(cfg, appId, opt) {
  appId = String(appId || '').toLowerCase();
  if (!APP_ID_RE.test(appId)) fail('usage: mdt app import <appId> [--ootb] [--as FOLDER]');
  const dev = new Device(cfg, opt).ensure();
  if (!dev.listApps().includes(appId)) fail(`${appId} is not installed on the device`);
  const zip = path.join(P.tmp, `${appId}-app-source.zip`);
  if (dev.pullTo(`cat ${dev.appDir(appId)}/app-source.zip`, zip) < 100) fail(`no app-source.zip for ${appId} on the device`);
  if (opt.ootb) {
    const r = proj.importAppOotb(zip, {as: opt.as});
    ok(`MobileApps/OOTB/${r.folder} = ${appId} ${r.ai.version} from the device`);
    for (const w of r.warnings) warn(`not pristine? ${w}`);
    return;
  }
  const folder = opt.as || appId.toUpperCase();
  const dest = path.join(P.appsCust, folder);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) fail(`${rel(dest)} exists and is not empty`);
  fs.mkdirSync(dest, {recursive: true});
  run(tarExe(), ['-xf', zip, '-C', dest]);
  fs.rmSync(zip, {force: true});
  ok(`MobileApps/CUSTOMIZED/${folder} = ${appId} as deployed on the server`);
  warn(`add its pristine version too (mdt ootb app <download> --as ${folder}) so upgrades can merge it`);
}

function buildFor(cfg, appRef, opt) {
  const app = appOf(appRef);
  if (opt.release) {
    const dir = latestRelease(app.id, opt.release);
    const rj = readJson(path.join(dir, 'release.json'));
    const idx = path.join(P.tmp, `${app.id}-index.html`);
    fs.mkdirSync(P.tmp, {recursive: true});
    fs.writeFileSync(idx, capture(tarExe(), ['-xOf', path.join(dir, rj.zip), 'index.html'], {binary: true}).stdout);
    return {app, meta: rj, zip: path.join(dir, rj.zip), index: idx, from: rel(dir)};
  }
  const out = P.out(app.id);
  const meta = readJson(path.join(out, 'mdt-build.json')) || fail(`no build for ${app.id}: mdt build ${app.id}`);
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

// ================================================================ agent policy

function cmdPolicy(cfg, {pos}) {
  if (pos[0] === 'set') {
    const changes = {};
    for (const kv of pos.slice(1)) {
      const [k, v] = kv.split('=');
      if (!LEVELS[k]) fail(`unknown policy key ${k} (keys: ${Object.keys(LEVELS).join(', ')})`);
      if (!LEVELS[k].includes(v)) fail(`${k} must be one of: ${LEVELS[k].join(' | ')}`);
      changes[k] = v;
    }
    if (!Object.keys(changes).length) fail('usage: mdt policy set device=auto device-ui=ask framework=read-only ...');
    writeLocalPolicy(changes);
    ok(`wrote ${rel(POLICY_FILES[1])}`);
  }
  const {policy, sources} = loadPolicy();
  console.log(c.bold('agent policy') + c.dim('  (AGENTS.md, overridden by AGENTS.local.md)'));
  for (const [k, v] of Object.entries(policy)) console.log(`  ${k.padEnd(12)} ${v.padEnd(10)} ${c.dim(`${sources[k]}   options: ${LEVELS[k].join(' | ')}`)}`);
  console.log(hookInstalled() ? c.dim('  Claude Code hook: installed (.claude/settings.json)') : c.yellow(`  ${HOOK_HINT}`));
}

// Refuse blocked actions for non-interactive callers (agents). People in a
// terminal are not stopped; the Claude Code hook also asks for "ask" levels.
function enforcePolicy(argv) {
  const cls = classifyMdt(argv.filter(a => !a.startsWith('--') || a === '--dry-run' || a === '--reload'));
  if (!cls) return;
  const d = decide(loadPolicy().policy, cls);
  if (d.decision === 'deny' && !process.stdin.isTTY && !process.env.MDT_POLICY_OVERRIDE) {
    fail(`blocked by agent policy (${d.key}: ${d.level}). Change it with \`mdt policy set ${d.key}=...\` in your own terminal, or edit AGENTS.local.md.`);
  }
}

// ================================================================ driving the app

async function cmdDrive(cfg, cmd, rest, opt) {
  const dev = new Device(cfg, opt).ensure();
  const app = opt.app || 'current';
  switch (cmd) {
    case 'ui': {
      const u = await drive.uiDump(dev, {app, all: !!opt.all, textLimit: Number(opt['text-limit'] || 2500)});
      return console.log(opt.json ? JSON.stringify(u, null, 1) : drive.formatUi(u));
    }
    case 'tap':
      return drive.tap(dev, rest[0], opt);
    case 'type':
      return drive.type(dev, rest[0], rest[1], opt);
    case 'key':
      return drive.key(dev, rest[0] || '');
    case 'scroll':
      return drive.scroll(dev, rest[0] || 'down', opt);
    case 'wait':
      if (!rest[0] && !opt.selector) fail('usage: mdt wait "<text>" | --selector <css>  [--timeout 20] [--gone]');
      return drive.waitFor(dev, rest[0], opt);
    case 'eval':
      if (!rest[0]) fail('usage: mdt eval "<js expression>" [--app <id>|navigator]');
      return console.log(JSON.stringify(await drive.evalJs(dev, rest[0], {app}), null, 1));
    case 'state': {
      const st = await drive.appState(dev, {app});
      if (st?.error) fail(st.error);
      if (!st.hook) return warn(`${st.app}: no test hook. It exists in mdt debug builds only: mdt deploy ${st.app} --debug`);
      return console.log(JSON.stringify(st, null, 1));
    }
    case 'console': {
      const before = opt.reload ? async () => reload(dev, String(opt.app || rest[0] || 'navigator').toLowerCase()) : null;
      const msgs = await drive.consoleLog(dev, opt, before);
      if (opt.json) return console.log(JSON.stringify(msgs, null, 1));
      for (const m of msgs.slice(-Number(opt.limit || 200))) console.log(`${m.level.padEnd(9)} ${m.text.slice(0, 500)}${m.at ? c.dim(`  @${m.at}`) : ''}`);
      return info(`${msgs.length} message(s)${opt.errors ? ' (errors/warnings only)' : ''}`);
    }
    case 'screenshot': {
      const outFile = opt.out ? path.resolve(opt.out) : undefined;
      return console.log(opt.webview ? await drive.webviewScreenshot(dev, outFile) : drive.screenshot(dev, outFile));
    }
    case 'logcat':
      return console.log(drive.logcat(dev, opt));
  }
}

// ================================================================ main

const HELP = `mdt - Maximo Mobile dev toolkit   (project ${ROOT})

project layout
  Framework/OOTB  Framework/CUSTOMIZED        IBM framework / yours (builds use CUSTOMIZED)
  MobileApps/OOTB/<APP>  MobileApps/CUSTOMIZED/<APP>   IBM app / yours

setup
  init                        prerequisites, Framework/OOTB from images/*.tar, build env from the device
  doctor | status
  env | env detect [app] | env set VITE_X=... | env unset VITE_X

OOTB, customizations, Maximo upgrades
  ootb framework [image.tar] [--packages a,b]     Framework/OOTB := sources from the image
  ootb app <download.zip|folder> [--as FOLDER]    MobileApps/OOTB/<APP> := pristine app download
  diff [framework|<app>] [--files] [--no-save]    CUSTOMIZED vs OOTB -> patches/<name>.patch
  upgrade [--dry-run] [--base REF] [--force]      merge OOTB changes since REF (default HEAD) into CUSTOMIZED

build & device   (device commands need a debuggable Maximo Mobile APK)
  build <app> [--debug] [--no-framework]
  device | backup <app> | app import <appId> [--ootb] [--as FOLDER]
  push <app> [--release [dir]] [--dry-run] [--no-backup] [--no-reload] [--restart] [--keep-old-assets]
  deploy <app> [--debug]      build + push
  reload [app] [--restart] | restore <app> [backup.tar]

drive & test the app on the device   (target = visible app; --app <id>|navigator)
  ui [--all] [--json]         visible controls as [ref] lines + page text
  tap <ref|"text"> | --id <element id> | --selector css | --xy x,y [--nth N] [--js]
  type <ref|"text"> "value" [--clear] [--enter]
  key back|wake|enter|tab|escape|backspace|arrowdown|arrowup
  scroll [down|up|<ref>]      wait "<text>" | --selector css [--timeout 20] [--gone]
  state                       page, page stack, datasource counts (debug builds)
  eval "<js>"                 run JS in the app window, print the result
  console [--seconds 3] [--errors] [--reload]     logcat [--lines 200] [--grep re]
  screenshot [--webview] [--out f.png]

agent policy   (AGENTS.md defaults, AGENTS.local.md per clone; enforced by the Claude Code hook)
  policy | policy set device=auto device-ui=ask framework=read-only apps=auto uploads=never ...

release
  package <app>               release build -> dist/<app>/<version>-<time>/ (binary, source zips, release.json)
  upload <app> --target T [--release dir] [--dry-run] [--yes]   send the packaged binary to Maximo
  publish <app> --target T    package + upload
  image build [--tag T] [--save [file.tar]]   bake Framework/CUSTOMIZED into a new image

options: --serial <adb serial>
`;

const VALUE_OPTS = new Set([
  'packages', 'name', 'tag', 'save', 'out', 'target', 'release', 'serial', 'as', 'to', 'base',
  'app', 'selector', 'text', 'nth', 'xy', 'seconds', 'timeout', 'lines', 'grep', 'limit', 'text-limit', 'id'
]);

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
  enforcePolicy(process.argv.slice(2));
  switch (cmd) {
    case 'init':
      return cmdInit(cfg, a);
    case 'doctor':
      return void doctor(cfg);
    case 'status':
      return cmdStatus(cfg);
    case 'env':
      return cmdEnv(cfg, a);
    case 'policy':
      return cmdPolicy(cfg, a);
    case 'ootb':
      return cmdOotb(cfg, a);
    case 'diff':
      return cmdDiff(cfg, a);
    case 'upgrade':
      return cmdUpgrade(cfg, a);
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
    case 'image':
      if (rest[0] === 'build') return cmdImageBuild(cfg, opt);
      fail('usage: mdt image build [--tag T] [--save [file.tar]]');
      break;
    case 'app':
      if (rest[0] === 'import') return cmdAppImport(cfg, rest[1], opt);
      fail('usage: mdt app import <appId> [--ootb] [--as FOLDER]');
      break;
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
    case 'ui':
    case 'tap':
    case 'type':
    case 'key':
    case 'scroll':
    case 'wait':
    case 'eval':
    case 'state':
    case 'console':
    case 'screenshot':
    case 'logcat':
      return cmdDrive(cfg, cmd, rest, opt);
    default:
      process.stdout.write(HELP);
  }
}

main().catch(e => {
  if (e instanceof MdtError) console.error(c.red(`[mdt] ${e.message}`));
  else console.error(e);
  process.exit(1);
});
