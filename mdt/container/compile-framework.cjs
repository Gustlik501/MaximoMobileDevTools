#!/usr/bin/env node
/*
 * Runs INSIDE the graphite-configuration container.
 *
 * Finds every framework file you changed or added (compared to the pristine
 * baseline written by extract-framework.cjs), compiles changed .js files with
 * the Babel that ships in the image, and writes the result:
 *
 *   --apply      over /graphite/node_modules/@maximo/<pkg>/build/ejs/<file>
 *                (and build/commonjs/<file> when that twin exists), so the app
 *                build bundles your framework code. Every importer resolves the
 *                package exactly as before, so there is only one framework copy.
 *   --overlay D  into D/<pkg>/build/ejs/<file> (used to bake a patched image).
 *
 * Unchanged files are left as IBM compiled them.
 *
 * usage: compile-framework.cjs --framework /framework --baseline /baseline
 *          [--modules /graphite/node_modules/@maximo] [--apply] [--overlay /out/overlay]
 *          [--report /out/framework-report.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function args() {
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (!v[i].startsWith('--')) continue;
    const k = v[i].slice(2);
    a[k] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true;
  }
  return a;
}

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

function* walk(dir, rel = '') {
  if (!fs.existsSync(path.join(dir, rel))) return;
  for (const e of fs.readdirSync(path.join(dir, rel), {withFileTypes: true})) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(dir, r);
    else if (e.isFile()) yield r;
  }
}

function writeFile(p, data) {
  fs.mkdirSync(path.dirname(p), {recursive: true});
  fs.writeFileSync(p, data);
}

let babel = null;
let presetEnv = null;
let presetReact = null;
function loadBabel() {
  if (babel) return;
  const paths = ['/graphite', ...(process.env.NODE_PATH || '').split(':').filter(Boolean)];
  babel = require(require.resolve('@babel/core', {paths}));
  presetEnv = require.resolve('@babel/preset-env', {paths});
  presetReact = require.resolve('@babel/preset-react', {paths});
}

// Modern target: the Maximo Mobile WebView is current Chromium, so async/await
// and classes stay native (better debugging, no regenerator runtime needed).
// Native classes interoperate with IBM's ES5-compiled classes in both directions.
function compile(code, displayName, modules) {
  loadBabel();
  const res = babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    filename: displayName,
    sourceFileName: displayName,
    sourceMaps: 'inline',
    compact: false,
    presets: [
      [presetEnv, {modules, targets: modules === 'commonjs' ? {node: '18'} : {chrome: '90'}, bugfixes: true}],
      [presetReact, {runtime: 'automatic'}]
    ]
  });
  return res.code;
}

function main() {
  const a = args();
  const fwRoot = a.framework || '/framework';
  const blRoot = a.baseline || '/baseline';
  const modules = a.modules || '/graphite/node_modules/@maximo';
  const overlay = a.overlay && a.overlay !== true ? a.overlay : null;
  const apply = !!a.apply;
  const manifestPath = path.join(blRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.log('[framework] no baseline manifest, nothing to compile');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const report = {changed: [], added: [], deleted: [], errors: []};

  for (const [pkg, info] of Object.entries(manifest.packages || {})) {
    const fwPkg = path.join(fwRoot, pkg);
    if (!fs.existsSync(fwPkg)) continue;
    const seen = new Set();
    for (const rel of walk(fwPkg)) {
      seen.add(rel);
      const data = fs.readFileSync(path.join(fwPkg, rel));
      const base = info.files[rel];
      if (base && base === sha(data)) continue;
      (base ? report.changed : report.added).push(`${pkg}/${rel}`);

      const targets = [];
      const ejsRel = `build/ejs/${rel}`;
      const cjsRel = `build/commonjs/${rel}`;
      if (apply) {
        targets.push({file: path.join(modules, pkg, ejsRel), mod: false});
        if (fs.existsSync(path.join(modules, pkg, cjsRel))) {
          targets.push({file: path.join(modules, pkg, cjsRel), mod: 'commonjs'});
        }
      }
      if (overlay) {
        targets.push({file: path.join(overlay, pkg, ejsRel), mod: false});
        if (fs.existsSync(path.join(modules, pkg, cjsRel))) {
          targets.push({file: path.join(overlay, pkg, cjsRel), mod: 'commonjs'});
        }
      }

      try {
        const isJs = rel.endsWith('.js') || rel.endsWith('.jsx') || rel.endsWith('.mjs');
        for (const t of targets) {
          if (isJs) {
            const out = compile(data.toString('utf8'), `framework/${pkg}/${rel}`, t.mod);
            writeFile(t.file, out);
            // the compiled file now carries an inline map; drop IBM's stale external one
            if (fs.existsSync(`${t.file}.map`)) fs.unlinkSync(`${t.file}.map`);
          } else {
            writeFile(t.file, data);
          }
        }
      } catch (e) {
        report.errors.push({file: `${pkg}/${rel}`, message: String(e.message || e)});
      }
    }
    for (const rel of Object.keys(info.files)) {
      if (!seen.has(rel)) report.deleted.push(`${pkg}/${rel}`);
    }
  }

  const n = report.changed.length + report.added.length;
  console.log(`[framework] ${report.changed.length} changed, ${report.added.length} added, ${report.deleted.length} deleted`);
  for (const f of report.changed) console.log(`[framework]   M ${f}`);
  for (const f of report.added) console.log(`[framework]   A ${f}`);
  for (const f of report.deleted) console.log(`[framework]   D ${f}  (ignored: IBM's compiled file stays in place)`);
  if (a.report && a.report !== true) writeFile(a.report, JSON.stringify(report, null, 1));
  if (report.errors.length) {
    for (const e of report.errors) console.error(`[framework] ERROR ${e.file}: ${e.message}`);
    process.exit(2);
  }
  if (n && apply) console.log('[framework] overlay applied to node_modules');
}

try {
  main();
} catch (e) {
  console.error(`[framework] FAILED: ${e.stack || e}`);
  process.exit(1);
}
