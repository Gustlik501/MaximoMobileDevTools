#!/usr/bin/env node
/*
 * Runs INSIDE the graphite-configuration container.
 *
 * Compares Framework/CUSTOMIZED (/framework) with Framework/OOTB (/ootb), compiles
 * every changed or added .js with the Babel that ships in the image, and writes:
 *
 *   --apply      over /graphite/node_modules/@maximo/<pkg>/build/ejs/<file>
 *                (and build/commonjs/<file> when that twin exists), so the app
 *                build bundles your framework code. Every importer resolves the
 *                package exactly as before, so there is only one framework copy.
 *   --overlay D  into D/<pkg>/build/ejs/<file> (used to bake a patched image).
 *
 * Files identical to OOTB stay exactly as IBM compiled them.
 *
 * usage: compile-framework.cjs --framework /framework --ootb /ootb
 *          [--modules /graphite/node_modules/@maximo] [--apply] [--overlay /out/overlay]
 *          [--report /out/framework-report.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');

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

// CRLF-insensitive comparison: a checkout's line endings are not a change
const norm = buf => (buf.subarray(0, 8000).includes(0) ? buf : Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n')));

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
  return babel.transformSync(code, {
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
  }).code;
}

function main() {
  const a = args();
  const fwRoot = a.framework || '/framework';
  const ootbRoot = a.ootb || '/ootb';
  const modules = a.modules || '/graphite/node_modules/@maximo';
  const overlay = a.overlay && a.overlay !== true ? a.overlay : null;
  const apply = !!a.apply;
  const report = {changed: [], added: [], deleted: [], errors: []};
  if (!fs.existsSync(fwRoot)) {
    console.log('[framework] no Framework/CUSTOMIZED: stock framework');
    return;
  }

  for (const pkg of fs.readdirSync(fwRoot, {withFileTypes: true}).filter(e => e.isDirectory()).map(e => e.name)) {
    const fwPkg = path.join(fwRoot, pkg);
    const ootbPkg = path.join(ootbRoot, pkg);
    if (!fs.existsSync(path.join(modules, pkg, 'build', 'ejs'))) {
      report.errors.push({file: pkg, message: `@maximo/${pkg} is not in this image`});
      continue;
    }
    const seen = new Set();
    for (const rel of walk(fwPkg)) {
      seen.add(rel);
      const data = fs.readFileSync(path.join(fwPkg, rel));
      const ootbFile = path.join(ootbPkg, rel);
      const exists = fs.existsSync(ootbFile);
      if (exists && norm(fs.readFileSync(ootbFile)).equals(norm(data))) continue;
      (exists ? report.changed : report.added).push(`${pkg}/${rel}`);

      const targets = [];
      const ejsRel = `build/ejs/${rel}`;
      const cjsRel = `build/commonjs/${rel}`;
      const hasCjs = fs.existsSync(path.join(modules, pkg, cjsRel));
      if (apply) {
        targets.push({file: path.join(modules, pkg, ejsRel), mod: false});
        if (hasCjs) targets.push({file: path.join(modules, pkg, cjsRel), mod: 'commonjs'});
      }
      if (overlay) {
        targets.push({file: path.join(overlay, pkg, ejsRel), mod: false});
        if (hasCjs) targets.push({file: path.join(overlay, pkg, cjsRel), mod: 'commonjs'});
      }
      try {
        const isJs = /\.(js|jsx|mjs)$/.test(rel);
        for (const t of targets) {
          if (isJs) {
            writeFile(t.file, compile(data.toString('utf8'), `framework/${pkg}/${rel}`, t.mod));
            // the compiled file carries an inline map; drop IBM's stale external one
            if (fs.existsSync(`${t.file}.map`)) fs.unlinkSync(`${t.file}.map`);
          } else {
            writeFile(t.file, data);
          }
        }
      } catch (e) {
        report.errors.push({file: `${pkg}/${rel}`, message: String(e.message || e)});
      }
    }
    for (const rel of walk(ootbPkg)) if (!seen.has(rel)) report.deleted.push(`${pkg}/${rel}`);
  }

  console.log(`[framework] ${report.changed.length} changed, ${report.added.length} added, ${report.deleted.length} deleted (vs OOTB)`);
  for (const f of report.changed) console.log(`[framework]   M ${f}`);
  for (const f of report.added) console.log(`[framework]   A ${f}`);
  for (const f of report.deleted) console.log(`[framework]   D ${f}  (ignored: IBM's compiled file stays in place)`);
  if (a.report && a.report !== true) writeFile(a.report, JSON.stringify(report, null, 1));
  if (report.errors.length) {
    for (const e of report.errors) console.error(`[framework] ERROR ${e.file}: ${e.message}`);
    process.exit(2);
  }
  if (apply && report.changed.length + report.added.length) console.log('[framework] overlay applied to node_modules');
}

try {
  main();
} catch (e) {
  console.error(`[framework] FAILED: ${e.stack || e}`);
  process.exit(1);
}
