// Framework sources: extract from the image, track edits, save/load the patch.
//
//   framework/<profile>/<package>/...   working copy you edit (git-ignored)
//   .mdt/baseline/<profile>/            pristine IBM sources + manifest.json (sha256)
//   patches/framework.patch             your edits, portable across image versions (tracked)
import fs from 'node:fs';
import path from 'node:path';
import {containerRun} from './container.mjs';
import {TOOL_DIR, P, ROOT, capture, fail, info, rel, sha256, sha256File, walk, warn, readJson} from './util.mjs';

export function manifest(profile) {
  return readJson(path.join(P.baseline(profile), 'manifest.json'));
}

export function extract(cfg, prof, packages, {force = false} = {}) {
  info(`extracting framework sources (${packages.join(', ')}) from image ${prof.image.slice(0, 12)} ...`);
  const r = containerRun(
    cfg,
    prof.image,
    [
      [TOOL_DIR, '/mdt', 'ro'],
      [P.framework(prof.name), '/framework'],
      [P.baseline(prof.name), '/baseline']
    ],
    {},
    `node /mdt/container/extract-framework.cjs --packages ${packages.join(',')} --out /framework --baseline /baseline --image ${prof.image} --profile ${prof.name}${force ? ' --force' : ''}`
  );
  if (r.status !== 0) fail('framework extract failed');
}

export function status(profile) {
  const mf = manifest(profile);
  const res = {changed: [], added: [], deleted: [], rejects: []};
  if (!mf) return res;
  for (const [pkg, pinfo] of Object.entries(mf.packages)) {
    const dir = path.join(P.framework(profile), pkg);
    const seen = new Set();
    for (const f of walk(dir)) {
      if (f.endsWith('.rej') || f.endsWith('.orig')) {
        res.rejects.push(`${pkg}/${f}`);
        continue;
      }
      seen.add(f);
      const h = pinfo.files[f];
      if (!h) res.added.push(`${pkg}/${f}`);
      else if (h !== sha256(fs.readFileSync(path.join(dir, f)))) res.changed.push(`${pkg}/${f}`);
    }
    for (const f of Object.keys(pinfo.files)) if (!seen.has(f)) res.deleted.push(`${pkg}/${f}`);
  }
  return res;
}

export const editCount = st => st.changed.length + st.added.length;

/** Unified diff of the working copy vs baseline, with <package>/<file> paths. */
export function diff(profile) {
  const st = status(profile);
  const bl = rel(P.baseline(profile));
  const fw = rel(P.framework(profile));
  let patch = '';
  for (const f of [...st.changed, ...st.added].sort()) {
    const a = st.added.includes(f) ? '/dev/null' : `${bl}/${f}`;
    const r = capture('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', a, `${fw}/${f}`], {cwd: ROOT, allowFail: true});
    patch += r.stdout.split(`a/${bl}/`).join('a/').split(`a/${fw}/`).join('a/').split(`b/${fw}/`).join('b/');
  }
  return patch;
}

/** 'none' | 'saved' | 'unsaved' | 'not-loaded' */
export function patchState(profile) {
  const current = diff(profile);
  const saved = fs.existsSync(P.frameworkPatch) ? fs.readFileSync(P.frameworkPatch, 'utf8') : '';
  if (!current && !saved) return 'none';
  if (current === saved) return 'saved';
  if (!current && saved) return 'not-loaded';
  return 'unsaved';
}

export function save(profile) {
  const patch = diff(profile);
  fs.mkdirSync(P.patches, {recursive: true});
  fs.writeFileSync(P.frameworkPatch, patch);
  return {files: (patch.match(/^diff --git /gm) || []).length, sha: sha256(patch)};
}

/** Restore the pristine IBM sources (removes added files and reject files). */
export function reset(profile) {
  const st = status(profile);
  for (const f of [...st.changed, ...st.deleted]) {
    const dst = path.join(P.framework(profile), f);
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.copyFileSync(path.join(P.baseline(profile), f), dst);
  }
  for (const f of [...st.added, ...st.rejects]) fs.rmSync(path.join(P.framework(profile), f), {force: true});
  return st;
}

/** git apply a patch onto the working copy. Hunks that don't fit go to *.rej. */
export function apply(profile, patchFile) {
  if (!fs.existsSync(patchFile) || !fs.statSync(patchFile).size) return {ok: true, empty: true};
  // keep IBM's LF endings even when git runs with core.autocrlf=true
  const r = capture(
    'git',
    ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--reject', '--whitespace=nowarn', `--directory=${rel(P.framework(profile))}`, patchFile],
    {cwd: ROOT, allowFail: true}
  );
  const out = `${r.stdout}${r.stderr}`;
  const rejects = status(profile).rejects;
  if (r.status !== 0 || rejects.length) {
    warn(`patch did not apply cleanly to framework/${profile}:`);
    for (const l of out.split(/\r?\n/).filter(x => /error|Rejected|reject/i.test(x))) warn(`  ${l.trim()}`);
    return {ok: false, rejects};
  }
  return {ok: true};
}

/** Working copy := baseline + patches/framework.patch */
export function load(profile) {
  reset(profile);
  if (!fs.existsSync(P.frameworkPatch)) return {ok: true, empty: true};
  const r = apply(profile, P.frameworkPatch);
  if (r.ok) info(`loaded patches/framework.patch into framework/${profile}`);
  return r;
}

export function patchFileSha() {
  return fs.existsSync(P.frameworkPatch) ? sha256File(P.frameworkPatch) : null;
}
