---
name: mdt-setup
description: Set up a Maximo Mobile project from the MobileDevTools template - new private repo, graphite-configuration image tar into images/, Framework/OOTB from the image, pristine app downloads into MobileApps/OOTB, the customized apps into MobileApps/CUSTOMIZED, build env, first commit. Also prerequisites (Node, Podman, adb) and `mdt init` / `mdt doctor` problems.
---

# Setting up a project

One private repo per customer project, created from this template. It holds IBM's
pristine sources (OOTB) next to the project's (CUSTOMIZED). The template itself has no
IBM code; a project repo does, so it must be private.

## Steps

1. `.\mdt.cmd doctor` (Git Bash: `./mdt.sh doctor`). Needs Node >= 22, Podman, git,
   curl; a debuggable APK only for device work (adb ships in `mdt/platform-tools/`). The
   folder must be a git repo.
2. **Framework.** Copy the environment's `mas/graphite-configuration` tar into `images/`
   (`images/README.md` shows how to pull it), then run `mdt init`. It loads the image,
   extracts `Framework/OOTB` (sources rebuilt from the image's source maps), copies it to
   `Framework/CUSTOMIZED`, writes `Framework/ootb.json` (which image) and reads the
   `VITE_*` build env from the device.
3. **Apps.** For each app, the user downloads the **pristine** app from the MAS
   Configuration app. Then run `mdt ootb app <download.zip> --as TECHMOBILE`, which
   creates `MobileApps/OOTB/TECHMOBILE` and copies it to CUSTOMIZED.
   - If mdt warns "not pristine?" (`*.delta.xml` files, or `src/` differs from
     `ibm-config/src/`), ask the user before going on.
   - An existing customized version replaces `MobileApps/CUSTOMIZED/<APP>`. The folder
     name must match the OOTB one.
   - Sources of what's deployed: `mdt app import <id>` (from the device, read-only)
     puts them in CUSTOMIZED.
4. `mdt status`, then `mdt diff` (what's customized vs OOTB) and `mdt build <app>`.
5. Suggest the first commit: `git add -A && git commit -m "Baseline ..."`, then
   `git tag ootb-<version>`. Upgrades use OOTB at the last commit as their merge base,
   so OOTB must be committed before the next IBM release is dropped in.

No device? Set the build env by hand:
`mdt env set VITE_ROUTING_MODE=subdomain VITE_MAS_DOMAIN=<host> VITE_ROOT_PATH=`.

## Troubleshooting

| symptom | fix |
|---|---|
| `podman not ready` | `podman machine start` (mdt tries once); none yet: `podman machine init` |
| `no OOTB yet` | the tar isn't in `images/`, or isn't graphite-configuration |
| `image ... is not loaded and no tar in images/ contains it` | the tar that `Framework/ootb.json` names is missing on this machine: copy it into `images/` |
| `upgrade needs ... git repository` | `git init` + first commit |
| adb not found (macOS/Linux) | `mdt adb update` fetches Google's platform-tools adb for this system into `mdt/platform-tools/` |
| use another adb (scrcpy, Android Studio) | `"device": {"adb": "C:\\path\\adb.exe"}` in mdt.json wins over the bundled one; `mdt adb` shows which one is used |
| `run-as ... failed` | the APK must be a debuggable build |
| several devices | `--serial <id>` |
| app missing in `mdt status` | the folder needs `src/app.xml` (`<maximo-application id=...>` or `<application id=...>`) |
| Docker instead of Podman | `"container": {"engine": "docker"}` in mdt.json |

`mdt.json` (device, build env, tar cache) is local and git-ignored.
