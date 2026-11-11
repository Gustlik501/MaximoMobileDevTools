#!/usr/bin/env node
/*
 * Runs INSIDE the graphite-configuration container.
 *
 * Rebuilds the original framework sources from the source maps that IBM ships
 * in node_modules/@maximo/<pkg>/build/ejs/*.js.map (sourcesContent), and copies
 * every non-JS asset (json, png, css, ...) next to them.
 *
 * Writes two identical trees:
 *   <out>/<pkg>/...        editable copy (your framework workspace)
 *   <baseline>/<pkg>/...   pristine copy, used for status/diff/compile
 * and <baseline>/manifest.json with a sha256 for every file.
 *
 * usage: extract-framework.cjs --modules /graphite/node_modules/@maximo
 *          --packages maximo-js-api,react-components --out /framework --baseline /baseline
 *          [--image <id>] [--profile <name>] [--force]
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
  const out = a.out;
  const baseline = a.baseline;
  if (!out || !baseline) throw new Error('--out and --baseline are required');

  const manifestPath = path.join(baseline, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : {packages: {}};
  manifest.profile = a.profile || manifest.profile;
  manifest.image = a.image || manifest.image;
  manifest.extractedAt = new Date().toISOString();

  for (const pkg of packages) {
    const pkgDir = path.join(modules, pkg);
    const ejs = path.join(pkgDir, 'build', 'ejs');
    if (!fs.existsSync(ejs)) {
      console.error(`[extract] ${pkg}: ${ejs} not found, skipping`);
      continue;
    }
    const outPkg = path.join(out, pkg);
    if (fs.existsSync(outPkg) && fs.readdirSync(outPkg).length && !a.force) {
      console.error(`[extract] ${pkg}: ${outPkg} already exists, not overwriting (use --force)`);
      continue;
    }
    const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
    const files = {};
    let fromMap = 0;
    let compiledOnly = 0;
    let assets = 0;
    for (const rel of walk(ejs)) {
      if (rel.endsWith('.js.map')) continue;
      let data;
      if (rel.endsWith('.js')) {
        const mapFile = path.join(ejs, `${rel}.map`);
        let content = null;
        if (fs.existsSync(mapFile)) {
          try {
            const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
            if (map.sourcesContent && map.sources && map.sources.length === 1 && map.sourcesContent[0]) {
              content = map.sourcesContent[0];
            }
          } catch (e) {
            /* fall through to compiled file */
          }
        }
        if (content !== null) {
          data = Buffer.from(content, 'utf8');
          fromMap++;
        } else {
          data = fs.readFileSync(path.join(ejs, rel));
          compiledOnly++;
        }
      } else {
        data = fs.readFileSync(path.join(ejs, rel));
        assets++;
      }
      writeFile(path.join(outPkg, rel), data);
      writeFile(path.join(baseline, pkg, rel), data);
      files[rel] = sha(data);
    }
    manifest.packages[pkg] = {version, sourceDir: 'build/ejs', files};
    console.log(
      `[extract] ${pkg}@${version}: ${fromMap} sources from maps, ${compiledOnly} compiled-only js, ${assets} assets`
    );
  }
  writeFile(manifestPath, JSON.stringify(manifest, null, 1));
}

try {
  main();
} catch (e) {
  console.error(`[extract] FAILED: ${e.stack || e}`);
  process.exit(1);
}
