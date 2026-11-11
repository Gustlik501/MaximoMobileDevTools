// Upload an already-built app zip to Maximo, the same two ways
// maxdev-cli upload-app does (we can't use it directly: it always re-zips,
// its --skip-zip check only looks at the first CLI argument).
//
//   apikey / userName+password -> PUT  <host>/<context>/<api|oslc>/os/OSLCMAFAPPDATA?appid=..&action=wsmethod:uploadFile&version=..
//   accessToken (MAS)          -> POST <host>/graphite/configtool/packages/<app>/binary?workspaceId=..&appid=<mas-id>&appDesc=..&version=..
//
// Targets live in targets/<name>.json (git-ignored, see targets/example.json).
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {P, curlExe, fail, info, ok, readJson} from './util.mjs';

export function loadTarget(name) {
  if (!name) fail('pass --target <name> (a file targets/<name>.json, see targets/example.json)');
  const file = path.join(P.targets, `${name}.json`);
  const t = readJson(file);
  if (!t) fail(`target not found or invalid JSON: ${file}`);
  for (const k of ['protocol', 'domain']) if (!t[k]) fail(`${file}: missing "${k}"`);
  if (!t.accessToken && !t.apikey && !(t.userName && t.password)) fail(`${file}: set accessToken, apikey, or userName + password`);
  if (t.accessToken && !t.workspaceid) fail(`${file}: accessToken uploads need "workspaceid"`);
  return {name, file, ...t};
}

export function describeTarget(t) {
  const how = t.accessToken ? 'MAS access token' : t.apikey ? 'API key' : `user ${t.userName}`;
  return `${t.name}: ${t.protocol}://${t.domain}${t.port ? `:${t.port}` : ''} (${how}${t.description ? `, ${t.description}` : ''})`;
}

function request(t, {appId, masId, version, description}) {
  if (t.accessToken) {
    const host = t.routingMode === 'path' || !t.port ? t.domain : `${t.domain}:${t.port}`;
    const q = `workspaceId=${t.workspaceid}&appid=${masId || ''}&appDesc=${description || ''}&version=${version}${t.isMobile ? '&isMobile=true' : ''}`;
    return {
      method: 'POST',
      url: encodeURI(`${t.protocol}://${host}/graphite/configtool/packages/${appId}/binary?${q}`),
      headers: [`x-access-token: ${t.accessToken}`],
      secrets: [t.accessToken]
    };
  }
  const ctx = t.context === '' || t.context === false ? '' : `/${t.context || 'maximo'}`;
  const port = t.port ? `:${t.port}` : '';
  const apiCtx = t.apikey ? 'api' : 'oslc';
  let url = `${t.protocol}://${t.domain}${port}${ctx}/${apiCtx}/os/OSLCMAFAPPDATA?appid=${appId}&action=wsmethod:uploadFile&version=${version}`;
  if (t.apikey) {
    url += `&apikey=${t.apikey}`;
    return {method: 'PUT', url, headers: [], secrets: [t.apikey]};
  }
  const maxauth = Buffer.from(`${t.userName}:${t.password}`).toString('base64');
  return {method: 'PUT', url, headers: [`maxauth: ${maxauth}`], secrets: [maxauth, t.password]};
}

export function uploadZip(t, meta, zipFile, {dryRun = false} = {}) {
  const req = request(t, meta);
  const mask = s => req.secrets.filter(Boolean).reduce((acc, v) => acc.split(v).join('***'), String(s));
  info(`${req.method} ${mask(req.url)}`);
  info(`  file ${path.basename(zipFile)} (${(fs.statSync(zipFile).size / 1e6).toFixed(1)} MB)`);
  if (dryRun) return info('dry run: nothing sent');

  // secrets go into a temporary curl config file, not onto the command line
  const q = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const cfgFile = path.join(P.tmp, `curl-${process.pid}.cfg`);
  fs.mkdirSync(P.tmp, {recursive: true});
  fs.writeFileSync(cfgFile, [`url = ${q(req.url)}`, `request = ${q(req.method)}`, ...req.headers.map(h => `header = ${q(h)}`)].join('\n') + '\n', {mode: 0o600});
  try {
    const args = ['-sS', '--fail-with-body', '-K', cfgFile, '-T', zipFile, '-w', '\nHTTP %{http_code}\n'];
    if (t.insecure) args.unshift('-k');
    const r = spawnSync(curlExe(), args, {encoding: 'utf8', maxBuffer: 1 << 26});
    if (r.error) fail(`curl: ${r.error.message}`);
    const out = mask(`${r.stdout || ''}${r.stderr || ''}`).trim();
    if (r.status !== 0) fail(`upload failed (curl exit ${r.status}):\n${out.slice(-2000)}`);
    console.log(out.slice(-2000));
    ok(`uploaded ${path.basename(zipFile)} to ${t.name}`);
  } finally {
    fs.rmSync(cfgFile, {force: true});
  }
}
