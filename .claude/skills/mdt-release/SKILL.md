---
name: mdt-release
description: Ship a Maximo Mobile app built with mdt - package a release (app binary zip, app-source.zip, Configuration-app source zip), upload it to a Maximo/MAS server, publish, prepare a zip for someone else to upload, or bake framework changes into a patched graphite-configuration image for production.
---

# Releasing

**Uploads change a shared server: only when the user asks, always `--dry-run`
first, and name the target environment back to the user before the real upload.**
Never upload debug builds (mdt refuses).

## Checklist

1. Framework: `mdt framework status` shows "patches/framework.patch is up to date"
   (`mdt framework save` otherwise), and the patch is committed. `mdt package`
   refuses unsaved edits so the release is reproducible.
2. App sources committed in their own repo. `release.json` records the commit and
   whether the tree was dirty.
3. `mdt package <app>` creates a release build in `dist/<app>/<version>-<time>/`.
4. Test that exact build: `mdt push <app> --release` (writes to the device: only if
   the user wants a device test).
5. `mdt upload <app> --target <name> --dry-run`, then show the user the method,
   URL (secrets masked) and target.
6. `mdt upload <app> --target <name>` asks to type the app id (`--yes` skips it,
   only when the user explicitly said so).

`mdt publish <app> --target <name>` = 3 + 6 in one go.

## What's in a release

| file | use |
|---|---|
| `<app>__ver-<version>.zip` | app binary (Vite build + app-source.zip, framework compiled in). This is what `mdt upload` sends |
| `<app>.zip` | sources in the MAS Configuration app's upload layout (`<app>/...`). Uploaded there, the **pod rebuilds with its own framework**: framework edits are lost unless the pod runs a patched image |
| `app-source.zip` | raw project archive, same as inside the binary |
| `release.json` | app/version, profile + image id, tool versions, framework files + patch sha, git commit, sha256 of every artifact |
| `framework.patch` | copy of the patch the release was built with (if any) |

`<version>` is the raw app.xml `version` attribute (e.g. `9.2.71.0`), as IBM's
tooling uses. Re-uploading the same version is fine: Maximo keeps a revision per
upload, and devices fetched a re-published 9.2.71 without a version change.

## Targets

`targets/<name>.json` (git-ignored; template `targets/example.json`): `protocol`,
`domain`, `port`, `context` (default `maximo`), and one of `apikey` /
`userName`+`password` / `accessToken` (MAS, needs `workspaceid`, `routingMode`).
`insecure: true` only for self-signed test clusters. Never print or commit these
files.

API key / user+password: `PUT .../<context>/{api|oslc}/os/OSLCMAFAPPDATA?appid=<app>&action=wsmethod:uploadFile&version=<v>`.
Access token: `POST .../graphite/configtool/packages/<app>/binary?workspaceId=..&appid=<mas-id>&version=<v>`.
If the user wants to upload some other way (Postman, a pipeline, a colleague), give
them the binary zip and the `--dry-run` request. Advise against writing app zips
into the Maximo database directly.

## Patched image (framework changes inside MAS)

Needed only when people also publish from the MAS Configuration app: that pod
builds with the image's framework.

```
mdt framework save
mdt image build --save        # FROM the IBM image + compiled overlay; verifies every patched file by sha256
```

Result: tag `localhost/mdt/graphite-configuration:<version>-mdt.<time>`, a
docker-archive tar in `dist/images/`, the build context in
`.mdt/image-build/<profile>/` (Containerfile, CHANGES.txt, framework.patch).
Pushing it to a registry and changing the cluster is the user's call and isn't
done by mdt: MAS pins the image by digest and the operator reconciles the
deployment, so it needs the override mechanism of their MAS version. IBM support
doesn't cover a modified framework. After every Maximo update: new tar, `mdt init`,
resolve rejects, `mdt framework save`, `mdt image build` again.
