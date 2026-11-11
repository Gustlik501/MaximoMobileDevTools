---
name: mdt-setup
description: Set up or refresh a MobileDevTools (mdt) workspace for Maximo Mobile - a fresh clone for a new environment, a new graphite-configuration image tar after a Maximo update, adding app sources (TECHMOBILE, NAVIGATOR, ...), checking prerequisites (Node, Podman, adb), or fixing `mdt init` / `mdt doctor` problems.
---

# Setting up an mdt workspace

One clone = one Maximo environment. The user supplies the IBM image tar and the
app sources; `mdt init` does the rest and is safe to re-run.

## Steps

1. `.\mdt.cmd doctor` (Git Bash: `./mdt.sh doctor`). Node >= 22, Podman ready,
   git, curl are required; adb + device are only needed for device work.
2. Image: the `mas/graphite-configuration` tar goes into `images/` (any name ending in
   `.tar`). `images/README.md` shows how to pull it from a cluster.
3. Apps: one folder per app in `apps/` (`apps/TECHMOBILE/src/app.xml` ...). Folders
   elsewhere: `mdt app add <path>`. Sources of what's installed on the device:
   `mdt app import <appId>` (read-only on the device).
4. `.\mdt.cmd init`. It loads the tar into Podman (first time takes minutes for
   ~3.5 GB), registers a profile named after the image version, extracts the
   framework into `framework/<profile>/`, applies `patches/framework.patch`,
   registers apps, and reads the `VITE_*` build env from the device.
5. Check: `mdt status`, then `mdt build <app>` (release, ~30 s). Build output goes
   to `out/<profile>/<app>/`.

If no device is connected, ask the user for the MAS domain and set the build env:
`mdt env set VITE_ROUTING_MODE=subdomain VITE_MAS_DOMAIN=<host> VITE_ROOT_PATH=`.
These end up in the app's `process.env`; the MAS pod sets the same three.

## New image (Maximo update)

Put the new tar in `images/`, run `mdt init`. The new profile gets fresh framework
sources with the patch applied. Rejected hunks show as `*.rej` in
`mdt framework status`; hand over to the `mdt-framework` skill to resolve them.
Then switch with `mdt image use <profile>`. Old profiles can be dropped with
`mdt image remove <profile> --rmi` (refuses while it holds unsaved framework edits).

## Troubleshooting

| symptom | fix |
|---|---|
| `podman not ready` | `podman machine start` (mdt tries once); no machine at all: `podman machine init` |
| `image ... has no /graphite/node_modules/@maximo/maximo-js-api` | wrong tar, it isn't graphite-configuration |
| profile name clash | two tars with the same version label: `mdt image add <tar> --name <name>` |
| adb not found | set `"device": {"adb": "C:\\path\\adb.exe"}` in mdt.json, or put adb on PATH |
| `run-as ... failed` / not debuggable | the APK must be a debuggable build; Play Store builds can't be used |
| several devices | `--serial <id>` (see `adb devices`) |
| app not discovered | the folder needs `src/app.xml` with `<maximo-application id=...>` or `<application id=...>` |
| Docker instead of Podman | `"container": {"engine": "docker"}` in mdt.json |

`mdt.json` is per clone and git-ignored; `mdt init` rebuilds most of it.
