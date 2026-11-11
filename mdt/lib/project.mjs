// OOTB vs CUSTOMIZED: importing IBM's sources, diffing your customizations,
// and merging a new IBM release into CUSTOMIZED (three-way, per file).
//
//   base   = OOTB as of the last commit (git show <base>:<path>)
//   theirs = OOTB in the working tree (the new IBM release you dropped in)
//   ours   = CUSTOMIZED
import fs from 'node:fs';
import path from 'node:path';
import {checkEngine, containerRun, imageExists, imageIdFromTar, inspectImage, loadImage} from './container.mjs';
import {
  DEFAULT_PACKAGES,
  P,
  ROOT,
  TOOL_DIR,
  capture,
  fail,
  git,
  info,
  isBinary,
  listApps,
  normalize,
  readAppInfo,
  readJson,
  rel,
  run,
  sha256,
  stamp,
  tarExe,
  walk,
  warn
} from './util.mjs';

export const fwMeta = () => readJson(P.fwMeta);

// ---------------------------------------------------------------- images

export function imageTars() {
  if (!fs.existsSync(P.images)) return [];
  return fs
    .readdirSync(P.images)
    .filter(f => f.endsWith('.tar'))
    .map(f => path.join(P.images, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/** image id of a tar, cached in mdt.json (reading a 3.5 GB tar's manifest takes a while) */
function tarId(cfg, tar) {
  const st = fs.statSync(tar);
  const key = rel(tar);
  cfg.tars ??= {};
  const hit = cfg.tars[key];
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.id;
  const id = imageIdFromTar(tar);
  cfg.tars[key] = {id, size: st.size, mtimeMs: st.mtimeMs};
  return id;
}

/** make sure the image Framework/OOTB came from is loaded in Podman */
export function ensureImage(cfg, id) {
  checkEngine(cfg);
  if (imageExists(cfg, id)) return;
  const tar = imageTars().find(t => tarId(cfg, t) === id);
  if (!tar) fail(`image ${id.slice(0, 12)} (Framework/ootb.json) is not loaded and no tar in images/ contains it`);
  loadImage(cfg, tar);
}

export function buildImage(cfg) {
  const meta = fwMeta();
  if (!meta) fail('no Framework/OOTB yet: put the graphite-configuration tar into images/ and run mdt init (or mdt ootb framework)');
  ensureImage(cfg, meta.image);
  return meta;
}

// ---------------------------------------------------------------- OOTB imports

const isEmptyDir = d => !fs.existsSync(d) || !fs.readdirSync(d).filter(f => !f.startsWith('.')).length;

/** Framework/OOTB := framework sources extracted from an image tar. */
export function importFrameworkOotb(cfg, tarArg, {packages} = {}) {
  checkEngine(cfg);
  // no tar given: the one OOTB came from (adding packages), else the newest (first setup)
  const current = fwMeta()?.tar && path.join(P.images, fwMeta().tar);
  const tar = tarArg ? path.resolve(tarArg) : current && fs.existsSync(current) ? current : imageTars()[0];
  if (!tar || !fs.existsSync(tar)) fail('no image tar: put the graphite-configuration .tar into images/');
  info(`reading ${path.basename(tar)} ...`);
  const id = tarId(cfg, tar) || fail(`${tar} is not a docker/podman image archive`);
  if (!imageExists(cfg, id)) loadImage(cfg, tar);
  const im = inspectImage(cfg, id);
  const old = fwMeta();
  const pkgs = packages || old?.packages || DEFAULT_PACKAGES;

  const tmp = path.join(P.tmp, `ootb-${stamp()}`);
  fs.mkdirSync(tmp, {recursive: true});
  info(`extracting ${pkgs.join(', ')} from ${im.labels.version}-${im.labels.release} (${id.slice(0, 12)}) ...`);
  const r = containerRun(
    cfg,
    id,
    [
      [TOOL_DIR, '/mdt', 'ro'],
      [tmp, '/out']
    ],
    {},
    `node /mdt/container/extract-framework.cjs --packages ${pkgs.join(',')} --out /out/ootb --info /out/extract.json`
  );
  if (r.status !== 0) fail('framework extract failed');
  const extract = readJson(path.join(tmp, 'extract.json'), {});
  fs.mkdirSync(P.fwOotb, {recursive: true});
  for (const pkg of pkgs) {
    fs.rmSync(path.join(P.fwOotb, pkg), {recursive: true, force: true});
    fs.renameSync(path.join(tmp, 'ootb', pkg), path.join(P.fwOotb, pkg));
  }
  fs.rmSync(tmp, {recursive: true, force: true});
  const meta = {
    image: im.fullId,
    tar: path.basename(tar),
    version: im.labels.version,
    release: im.labels.release,
    buildDate: im.labels['build-date'],
    tools: im.tools,
    packages: pkgs,
    extract,
    extractedAt: new Date().toISOString()
  };
  fs.writeFileSync(P.fwMeta, `${JSON.stringify(meta, null, 2)}\n`);
  const fresh = [];
  for (const pkg of pkgs) {
    if (isEmptyDir(path.join(P.fwCust, pkg))) {
      fs.cpSync(path.join(P.fwOotb, pkg), path.join(P.fwCust, pkg), {recursive: true});
      fresh.push(pkg);
    }
  }
  info(`Framework/OOTB = graphite-configuration ${meta.version}-${meta.release}, maximo-js-api ${im.tools['maximo-js-api']}`);
  if (fresh.length) info(`Framework/CUSTOMIZED/${fresh.join(', ')} created as a copy of OOTB`);
  if (old && old.image !== meta.image) warn('Framework/OOTB changed: run mdt upgrade to merge it into Framework/CUSTOMIZED');
  return meta;
}

/** MobileApps/OOTB/<FOLDER> := a pristine app download (zip or folder). */
export function importAppOotb(src, {as} = {}) {
  src = path.resolve(src || '');
  if (!fs.existsSync(src)) fail('usage: mdt ootb app <download.zip | folder> [--as FOLDER]');
  const stage = path.join(P.tmp, `app-${stamp()}`);
  fs.mkdirSync(stage, {recursive: true});
  if (fs.statSync(src).isDirectory()) fs.cpSync(src, stage, {recursive: true, filter: s => !/[\\/](\.git|node_modules|build|coverage)$/.test(s)});
  else run(tarExe(), ['-xf', src, '-C', stage]);
  // the Configuration app's zip has <app>/..., app-source.zip has the project at the root
  let root = stage;
  for (let i = 0; i < 2 && !readAppInfo(root); i++) {
    const dirs = fs.readdirSync(root, {withFileTypes: true}).filter(e => e.isDirectory());
    if (dirs.length !== 1) break;
    root = path.join(root, dirs[0].name);
  }
  const ai = readAppInfo(root) || fail(`${src} contains no src/app.xml`);
  for (const junk of ['.git', 'node_modules', 'build', 'coverage']) fs.rmSync(path.join(root, junk), {recursive: true, force: true});
  for (const f of walk(root)) {
    const p = path.join(root, f);
    const buf = fs.readFileSync(p);
    const n = normalize(buf);
    if (n !== buf && !n.equals(buf)) fs.writeFileSync(p, n);
  }

  // is it really pristine? customized downloads carry *.delta.xml or differ from ibm-config/src
  const warnings = [];
  const files = [...walk(root)];
  const deltas = files.filter(f => f.endsWith('.delta.xml'));
  if (deltas.length) warnings.push(`${deltas.length} *.delta.xml file(s): Configuration-app customizations`);
  const ibm = files.filter(f => f.startsWith('ibm-config/src/') && f.endsWith('.xml') && !f.endsWith('.delta.xml') && !f.endsWith('app-build-manifest.json'));
  const differs = ibm.filter(f => {
    const s = path.join(root, f.replace(/^ibm-config\//, ''));
    return fs.existsSync(s) && !fs.readFileSync(s).equals(fs.readFileSync(path.join(root, f)));
  });
  if (differs.length) warnings.push(`${differs.length} src XML file(s) differ from ibm-config/src (e.g. ${differs[0].replace(/^ibm-config\//, '')})`);

  const existing = Object.values(listApps()).find(a => a.id === ai.id.toLowerCase());
  const folder = as || existing?.folder || ai.id.toUpperCase();
  const dest = path.join(P.appsOotb, folder);
  fs.rmSync(dest, {recursive: true, force: true});
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  fs.renameSync(root, dest);
  fs.rmSync(stage, {recursive: true, force: true});
  const cust = path.join(P.appsCust, folder);
  const created = isEmptyDir(cust);
  if (created) fs.cpSync(dest, cust, {recursive: true});
  return {folder, ai, warnings, created};
}

// ---------------------------------------------------------------- trees & diffs

export function trees() {
  const list = [{name: 'framework', label: 'Framework', ootb: P.fwOotb, cust: P.fwCust}];
  for (const a of Object.values(listApps())) {
    list.push({name: a.id, label: `MobileApps/${a.folder}`, folder: a.folder, ootb: path.join(P.appsOotb, a.folder), cust: path.join(P.appsCust, a.folder)});
  }
  return list;
}

const readNorm = f => (fs.existsSync(f) ? normalize(fs.readFileSync(f)) : null);

/** CUSTOMIZED vs OOTB of one tree */
export function compareTree(tree) {
  const res = {changed: [], added: [], deleted: []};
  const seen = new Set();
  for (const f of walk(tree.cust)) {
    seen.add(f);
    const o = readNorm(path.join(tree.ootb, f));
    if (!o) res.added.push(f);
    else if (!o.equals(readNorm(path.join(tree.cust, f)))) res.changed.push(f);
  }
  for (const f of walk(tree.ootb)) if (!seen.has(f)) res.deleted.push(f);
  return res;
}

/** unified diff OOTB -> CUSTOMIZED with tree-relative paths (a/src/x.js b/src/x.js) */
export function patchOf(tree) {
  const cmp = compareTree(tree);
  const o = rel(tree.ootb);
  const c = rel(tree.cust);
  let out = '';
  for (const f of [...cmp.changed, ...cmp.added, ...cmp.deleted].sort()) {
    const a = cmp.added.includes(f) ? '/dev/null' : `${o}/${f}`;
    const b = cmp.deleted.includes(f) ? '/dev/null' : `${c}/${f}`;
    const r = git(['diff', '--no-index', '--no-color', '--ignore-cr-at-eol', a, b], {allowFail: true});
    out += r.stdout.split(`a/${o}/`).join('a/').split(`b/${c}/`).join('b/').split(`a/${c}/`).join('a/').split(`b/${o}/`).join('b/');
  }
  return {patch: out, cmp};
}

// ---------------------------------------------------------------- guards

/** files with unresolved conflict markers */
export function conflictFiles(dirs) {
  const hits = [];
  for (const d of dirs) {
    for (const f of walk(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).size > 4 << 20) continue;
      const buf = fs.readFileSync(p);
      if (isBinary(buf)) continue;
      if (/^<<<<<<< |^>>>>>>> /m.test(buf.toString('utf8'))) hits.push(rel(p));
    }
  }
  return hits;
}

export function isGitRepo() {
  const r = capture('git', ['rev-parse', '--is-inside-work-tree'], {cwd: ROOT, allowFail: true});
  return r.status === 0 && r.stdout.trim() === 'true';
}

const OOTB_PATHS = ['Framework/OOTB', 'Framework/ootb.json', 'MobileApps/OOTB'];
const CUST_PATHS = ['Framework/CUSTOMIZED', 'MobileApps/CUSTOMIZED'];

/** OOTB files that differ from <base> (the new IBM release you dropped in) */
export function pendingOotb(base = 'HEAD') {
  if (!isGitRepo()) return [];
  if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {allowFail: true}).status !== 0) return [];
  const out = [];
  const d = git(['diff', '--name-status', '--no-renames', base, '--', ...OOTB_PATHS], {allowFail: true}).stdout;
  for (const line of d.split(/\r?\n/).filter(Boolean)) {
    const [st, p] = line.split('\t');
    out.push({status: st[0], path: p});
  }
  const u = git(['ls-files', '--others', '--exclude-standard', '--', ...OOTB_PATHS], {allowFail: true}).stdout;
  for (const p of u.split(/\r?\n/).filter(Boolean)) out.push({status: 'A', path: p});
  // a tree that had no files at <base> is a first import, not an upgrade
  const known = new Map();
  const hadFiles = root => {
    if (!known.has(root)) {
      const ls = git(['ls-tree', '-r', '--name-only', base, '--', root], {allowFail: true}).stdout;
      known.set(root, ls.split(/\r?\n/).some(f => f && !/(^|\/)\.gitkeep$/.test(f)));
    }
    return known.get(root);
  };
  return out
    .filter(e => !/(^|\/)\.gitkeep$/.test(e.path))
    .map(e => {
      const root = e.path.startsWith('Framework/') ? 'Framework/OOTB' : (e.path.match(/^MobileApps\/OOTB\/[^/]+/) || [e.path])[0];
      return {...e, root, initial: e.path !== 'Framework/ootb.json' && !hadFiles(root)};
    });
}

export function ootbHash() {
  const parts = [];
  for (const d of [P.fwOotb, P.appsOotb]) for (const f of walk(d)) parts.push(`${rel(path.join(d, f))}:${sha256(normalize(fs.readFileSync(path.join(d, f))))}`);
  if (fs.existsSync(P.fwMeta)) parts.push(`meta:${sha256(fs.readFileSync(P.fwMeta))}`);
  return sha256(parts.sort().join('\n'));
}

const statePath = () => path.join(P.upgrades, 'state.json');

/** message if OOTB was replaced but not merged into CUSTOMIZED yet */
export function upgradePending() {
  const pend = pendingOotb('HEAD').filter(p => p.path !== 'Framework/ootb.json' && !p.initial);
  if (!pend.length) return null;
  const st = readJson(statePath());
  if (st && st.ootbHash === ootbHash()) return null;
  return `OOTB has ${pend.length} file(s) changed since the last commit that are not merged into CUSTOMIZED: run mdt upgrade (or git checkout the OOTB folders)`;
}

// ---------------------------------------------------------------- upgrade (three-way merge)

function mapToCust(p) {
  if (p.startsWith('Framework/OOTB/')) return {tree: 'framework', rel: p.slice('Framework/OOTB/'.length), cust: `Framework/CUSTOMIZED/${p.slice('Framework/OOTB/'.length)}`};
  const m = p.match(/^MobileApps\/OOTB\/([^/]+)\/(.+)$/);
  if (m) return {tree: m[1], rel: m[2], cust: `MobileApps/CUSTOMIZED/${m[1]}/${m[2]}`};
  return null;
}

function mergeText(work, ours, base, theirs, baseLabel) {
  const f = n => path.join(work, n);
  fs.writeFileSync(f('ours'), ours);
  fs.writeFileSync(f('base'), base);
  fs.writeFileSync(f('theirs'), theirs);
  const r = capture('git', ['merge-file', '-p', '--diff3', '-L', 'CUSTOMIZED', '-L', `OOTB ${baseLabel}`, '-L', 'OOTB new', f('ours'), f('base'), f('theirs')], {
    allowFail: true,
    binary: true
  });
  if (r.status === null || r.status >= 128) return null;
  return {text: r.stdout, conflicts: r.status};
}

/**
 * Merge the OOTB changes (working tree vs <base>) into CUSTOMIZED.
 * Returns the per-file results; writes nothing with dryRun.
 */
export function upgrade(cfg, {base = 'HEAD', dryRun = false, force = false} = {}) {
  if (!isGitRepo()) fail('upgrade needs the project to be a git repository (OOTB as of the last commit is the merge base)');
  if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {allowFail: true}).status !== 0) {
    fail(`no commit "${base}": commit the current OOTB + CUSTOMIZED first, then drop the new OOTB in`);
  }
  const dirty = git(['status', '--porcelain', '--', ...CUST_PATHS], {allowFail: true}).stdout.trim();
  if (dirty && !force && !dryRun) fail('CUSTOMIZED has uncommitted changes: commit or stash them first, so the merge result can be reviewed and undone (or --force)');
  const all = pendingOotb(base).filter(p => p.path !== 'Framework/ootb.json');
  const firstImports = [...new Set(all.filter(p => p.initial).map(p => p.root))];
  if (firstImports.length) info(`first import, nothing to merge (commit it as the starting point): ${firstImports.join(', ')}`);
  const pend = all.filter(p => !p.initial);
  if (!pend.length) fail(`OOTB is unchanged since ${base}: drop the new release in first (mdt ootb framework <tar>, mdt ootb app <download>)`);

  const baseLabel = git(['rev-parse', '--short', base]).stdout.trim();
  const runDir = path.join(P.upgrades, stamp());
  const work = path.join(runDir, '.work');
  fs.mkdirSync(work, {recursive: true});
  const results = [];
  const xmlQueue = [];

  for (const {status, path: p} of pend) {
    const m = mapToCust(p);
    if (!m) continue;
    const B = status === 'A' ? null : normalize(git(['show', `${base}:./${p}`], {binary: true}).stdout);
    const T = status === 'D' ? null : readNorm(path.join(ROOT, p));
    const custAbs = path.join(ROOT, m.cust);
    const O = readNorm(custAbs);
    const res = {tree: m.tree, file: m.cust};
    const put = buf => !dryRun && (fs.mkdirSync(path.dirname(custAbs), {recursive: true}), fs.writeFileSync(custAbs, buf));
    const del = () => !dryRun && fs.rmSync(custAbs, {force: true});
    const eq = (a, b) => a && b && a.equals(b);

    if (!B && T) {
      if (!O) {
        res.action = 'added';
        put(T);
      } else if (eq(O, T)) res.action = 'same';
      else {
        res.action = 'conflict';
        res.note = 'IBM added a file you already have';
        const mm = !isBinary(O) && !isBinary(T) && mergeText(work, O, Buffer.alloc(0), T, baseLabel);
        if (mm) put(mm.text);
        res.conflicts = mm ? mm.conflicts : 1;
      }
    } else if (B && !T) {
      if (!O) res.action = 'same';
      else if (eq(O, B)) {
        res.action = 'deleted';
        del();
      } else {
        res.action = 'review';
        res.note = 'IBM removed this file, you customized it: kept yours';
      }
    } else if (B && T) {
      if (!O) {
        res.action = 'review';
        res.note = 'you removed this file, IBM changed it: left removed';
      } else if (eq(O, B)) {
        res.action = 'took-ibm';
        put(T);
      } else if (eq(O, T) || eq(B, T)) res.action = 'kept-yours';
      else if (isBinary(O) || isBinary(T)) {
        res.action = 'conflict';
        res.note = 'binary file changed by both: kept yours, IBM\'s copy is in the upgrade folder';
        res.conflicts = 1;
        const alt = path.join(runDir, 'ibm-new', m.cust);
        fs.mkdirSync(path.dirname(alt), {recursive: true});
        fs.writeFileSync(alt, T);
      } else {
        const mm = mergeText(work, O, B, T, baseLabel);
        if (!mm) fail(`git merge-file failed on ${p}`);
        put(mm.text);
        res.action = mm.conflicts ? 'conflict' : 'merged';
        if (mm.conflicts) {
          res.conflicts = mm.conflicts;
          if (m.tree !== 'framework' && p.endsWith('.xml')) xmlQueue.push({p, cust: m.cust, B, O, T});
        }
      }
    }
    results.push(res);
  }

  // second opinion for conflicting app XML: IBM's XML-aware delta merge (as the Configuration app does)
  if (xmlQueue.length) {
    const xroot = path.join(runDir, 'ibm-xml-merge');
    xmlQueue.forEach((x, i) => {
      const d = path.join(xroot, String(i));
      fs.mkdirSync(d, {recursive: true});
      fs.writeFileSync(path.join(d, 'base.xml'), x.B);
      fs.writeFileSync(path.join(d, 'custom.xml'), x.O);
      fs.writeFileSync(path.join(d, 'new.xml'), x.T);
      fs.writeFileSync(path.join(d, 'FILE.txt'), `${x.cust}\n`);
    });
    try {
      const meta = buildImage(cfg);
      const T = '/graphite/graphite-app-diff-tools/bin/graphite-app-diff-tools';
      const script = `for d in /x/*/; do ${T} diff -b"$d"base.xml -m"$d"custom.xml -t"$d"delta.xml > "$d"diff.log 2>&1 && ${T} apply -t"$d"delta.xml -i"$d"new.xml -o"$d"ibm-merged.xml -f > "$d"apply.log 2>&1 || echo "failed: $d"; done`;
      containerRun(cfg, meta.image, [[xroot, '/x']], {}, script);
      xmlQueue.forEach((x, i) => {
        const r = results.find(rr => rr.file === x.cust);
        const merged = path.join(xroot, String(i), 'ibm-merged.xml');
        if (fs.existsSync(merged)) {
          const log = fs.readFileSync(path.join(xroot, String(i), 'apply.log'), 'utf8');
          r.ibmXml = rel(merged);
          r.ibmXmlWarnings = (log.match(/warning/gi) || []).length;
        }
      });
    } catch (e) {
      warn(`IBM XML merge skipped: ${e.message}`);
    }
  }

  fs.rmSync(work, {recursive: true, force: true});
  writeReport(runDir, results, {base, baseLabel, dryRun});
  if (!dryRun) fs.writeFileSync(statePath(), JSON.stringify({base, baseCommit: baseLabel, ootbHash: ootbHash(), at: new Date().toISOString(), report: rel(path.join(runDir, 'REPORT.md'))}, null, 1));
  return {results, runDir};
}

function writeReport(runDir, results, {base, baseLabel, dryRun}) {
  const meta = fwMeta();
  const group = a => results.filter(r => r.action === a);
  const lines = [
    `# Upgrade ${dryRun ? '(dry run) ' : ''}${new Date().toISOString()}`,
    '',
    `Merge base: OOTB at \`${base}\` (${baseLabel}). New OOTB: working tree${meta ? `, framework from graphite-configuration ${meta.version}-${meta.release}` : ''}.`,
    ''
  ];
  const sect = (title, list, fmt) => {
    if (!list.length) return;
    lines.push(`## ${title} (${list.length})`, '', ...list.map(fmt), '');
  };
  sect('Conflicts: resolve the <<<<<<< markers', group('conflict'), r => `- \`${r.file}\`${r.conflicts ? ` (${r.conflicts} hunk(s))` : ''}${r.note ? `: ${r.note}` : ''}${r.ibmXml ? `\n  - IBM XML merge result (no markers, attribute order rewritten, ${r.ibmXmlWarnings} warning(s)): \`${r.ibmXml}\`` : ''}`);
  sect('Review', group('review'), r => `- \`${r.file}\`: ${r.note}`);
  sect('Merged cleanly (both changed)', group('merged'), r => `- \`${r.file}\``);
  sect('Took IBM\'s new version (you had not changed it)', group('took-ibm'), r => `- \`${r.file}\``);
  sect('Added by IBM', group('added'), r => `- \`${r.file}\``);
  sect('Deleted by IBM', group('deleted'), r => `- \`${r.file}\``);
  sect('Kept yours (IBM change already in, or IBM didn\'t change it)', group('kept-yours'), r => `- \`${r.file}\``);
  fs.mkdirSync(runDir, {recursive: true});
  fs.writeFileSync(path.join(runDir, 'REPORT.md'), lines.join('\n'));
}
