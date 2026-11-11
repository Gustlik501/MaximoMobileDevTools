// Podman/Docker access and graphite-configuration image inspection.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {capture, fail, info, run, tarExe} from './util.mjs';

export const engine = cfg => cfg.container.engine || 'podman';

export function engineStatus(cfg) {
  const r = spawnSync(engine(cfg), ['info', '--format', '{{.Host.Arch}}'], {encoding: 'utf8'});
  if (r.error) return {ok: false, why: `${engine(cfg)} not found (install Podman Desktop, or set "container.engine" in mdt.json)`};
  if (r.status !== 0) {
    return {ok: false, why: `${engine(cfg)} not ready: ${String(r.stderr).trim().split('\n').pop()} (try: podman machine start)`};
  }
  return {ok: true, arch: r.stdout.trim()};
}

export function checkEngine(cfg) {
  const s = engineStatus(cfg);
  if (!s.ok) fail(s.why);
}

/**
 * Run a throwaway container. mounts: [hostPath, containerPath, 'ro'?]
 */
export function containerRun(cfg, image, mounts, env, command, extra = []) {
  checkEngine(cfg);
  const args = ['run', '--rm'];
  for (const [host, dst, mode] of mounts) {
    if (!fs.existsSync(host)) fs.mkdirSync(host, {recursive: true});
    args.push('-v', `${host}:${dst}${mode ? `:${mode}` : ''}`);
  }
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(...extra, image, 'bash', '-c', command);
  return run(engine(cfg), args, {allowFail: true});
}

// Run one of mdt/container/*.sh; strip CR in case of a CRLF checkout.
export const containerScript = script => `tr -d '\\r' < /mdt/container/${script} > /tmp/${script} && bash /tmp/${script}`;

/** Image id of a `docker save` / `podman save` tar, without loading it. */
export function imageIdFromTar(tarFile) {
  const r = capture(tarExe(), ['-xOf', tarFile, 'manifest.json'], {allowFail: true});
  try {
    const cfgName = JSON.parse(r.stdout)[0].Config;
    return cfgName.replace(/^blobs\/sha256\//, '').replace(/\.json$/, '');
  } catch {
    return null;
  }
}

export function imageExists(cfg, id) {
  return spawnSync(engine(cfg), ['image', 'exists', id]).status === 0;
}

export function loadImage(cfg, tarFile) {
  info(`loading ${tarFile} into ${engine(cfg)} (a few minutes for ~3.5 GB) ...`);
  const r = capture(engine(cfg), ['load', '-i', tarFile]);
  const m = r.stdout.match(/sha256:([0-9a-f]{64})/) || r.stdout.match(/Loaded image(?:\(s\))?:\s*(\S+)/);
  return m && m[1];
}

const PROBE_PACKAGES = ['maximo-js-api', 'react-components', 'maximo-library', 'map-component', 'maxdev-cli', 'graphite-cli', 'app-processor'];

/** Labels + framework/tool versions of an image. */
export function inspectImage(cfg, id) {
  const insp = JSON.parse(capture(engine(cfg), ['image', 'inspect', id]).stdout)[0];
  const labels = insp.Labels || insp.Config?.Labels || {};
  const js = `for (const p of ${JSON.stringify(PROBE_PACKAGES)}) { try { console.log(p + ' ' + require('/graphite/node_modules/@maximo/' + p + '/package.json').version) } catch (e) {} }`;
  const r = capture(engine(cfg), ['run', '--rm', id, 'node', '-e', js], {allowFail: true});
  const tools = Object.fromEntries(r.stdout.split(/\r?\n/).filter(Boolean).map(l => l.split(' ')));
  if (!tools['maximo-js-api']) fail(`image ${id.slice(0, 12)} has no /graphite/node_modules/@maximo/maximo-js-api: is it mas/graphite-configuration?`);
  return {fullId: insp.Id.replace(/^sha256:/, ''), labels, tools, created: insp.Created};
}
