#!/usr/bin/env node
/*
 * Runs INSIDE the graphite-configuration container.
 *
 * Rebuilds IBM's original framework sources from the source maps shipped in
 * node_modules/@maximo/<pkg>/build/ejs/*.js.map (sourcesContent), and copies
 * every non-JS asset (json, png, css, ...) next to them. The result becomes
 * Framework/OOTB.
 *
 * usage: extract-framework.cjs --packages maximo-js-api,react-components --out /out/ootb
 *          [--modules /graphite/node_modules/@maximo] [--info /out/extract.json]
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

function main() {
  const a = args();
  const modules = a.modules || '/graphite/node_modules/@maximo';
  const packages = String(a.packages || 'maximo-js-api,react-components').split(',').filter(Boolean);
  if (!a.out) throw new Error('--out is required');
  const info = {};
  for (const pkg of packages) {
    const pkgDir = path.join(modules, pkg);
    const ejs = path.join(pkgDir, 'build', 'ejs');
    if (!fs.existsSync(ejs)) throw new Error(`${pkg}: ${ejs} not found`);
    const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
    let fromMap = 0;
    let compiledOnly = 0;
    let assets = 0;
    for (const rel of walk(ejs)) {
      if (rel.endsWith('.js.map')) continue;
      let data = null;
      if (rel.endsWith('.js')) {
        const mapFile = path.join(ejs, `${rel}.map`);
        if (fs.existsSync(mapFile)) {
          try {
            const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
            if (map.sourcesContent && map.sources && map.sources.length === 1 && map.sourcesContent[0]) {
              data = Buffer.from(map.sourcesContent[0], 'utf8');
              fromMap++;
            }
          } catch (e) {
            /* fall back to the compiled file */
          }
        }
        if (!data) {
          data = fs.readFileSync(path.join(ejs, rel));
          compiledOnly++;
        }
      } else {
        data = fs.readFileSync(path.join(ejs, rel));
        assets++;
      }
      writeFile(path.join(a.out, pkg, rel), data);
    }
    info[pkg] = {version, sources: fromMap, compiledOnly, assets};
    console.log(`[extract] ${pkg}@${version}: ${fromMap} sources from maps, ${compiledOnly} compiled-only js, ${assets} assets`);
  }
  if (a.info && a.info !== true) writeFile(a.info, JSON.stringify(info, null, 1));
}

try {
  main();
} catch (e) {
  console.error(`[extract] FAILED: ${e.stack || e}`);
  process.exit(1);
}
