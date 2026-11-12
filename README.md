# MobileDevTools

A project template for **Maximo Mobile** work where both the **apps** (TECHMOBILE,
NAVIGATOR, ...) and the **framework** (`@maximo/maximo-js-api`, `@maximo/react-components`,
...) are customized. Each project repo holds IBM's pristine sources (**OOTB**) next to
yours (**CUSTOMIZED**), so every Maximo update becomes a three-way merge instead of
re-doing customizations by hand. Builds run inside IBM's own `mas/graphite-configuration`
image, so the toolchain is exactly what MAS uses. You can test on a device over adb and
ship to Maximo.

```
mdt.cmd <command>     PowerShell / cmd          ./mdt.sh <command>    Git Bash / macOS / Linux
```

## Layout

```
Framework/
  OOTB/                IBM framework sources, rebuilt from the image's source maps   (mdt ootb framework)
  CUSTOMIZED/          your framework; builds use it                                  (you)
  ootb.json            which image OOTB came from; builds use that image
MobileApps/
  OOTB/TECHMOBILE/     IBM app sources as shipped (MAF Configuration download)        (mdt ootb app)
  CUSTOMIZED/TECHMOBILE/   your app; builds, pushes and publishes use it              (you)
images/                IBM image tars (local only, 3.5 GB each)
patches/               mdt diff output: what you changed vs OOTB, per tree (review)
AGENTS.md              agent rules + permission policy        mdt/  the tool
```

OOTB **and** CUSTOMIZED are committed. That means IBM's code is in the repo:
**every project repo must be private.** This template contains no IBM code. Git stores
identical files once, so CUSTOMIZED costs only the files you actually changed.

## Prerequisites

Node 22+, git, curl (built into Windows 10+), **Podman** (Podman Desktop with a machine)
or Docker (`"container": {"engine": "docker"}` in `mdt.json`). For device work: a
**debuggable** Maximo Mobile APK. `mdt doctor` checks all of it.

**adb ships with mdt**: Google's platform-tools adb for Windows, in `mdt/platform-tools/windows/`.
`mdt adb update` replaces it with the newest stable release (checked against the SHA-1 in
Google's SDK index); on macOS/Linux it fetches the adb for that system, `--os all` every
platform. mdt uses `device.adb` from `mdt.json` if set, else the bundled adb, else an
installed one (`mdt adb` shows which). One adb server serves the whole machine, and an adb
client of a different version can restart it, which drops scrcpy's connection and port
forwards. Use one adb for everything: start scrcpy with `ADB=<mdt's adb.exe>`, or point
`device.adb` at scrcpy's adb.

## New project

1. **Make the repo.** Create a new **private** repo from this template (GitHub: "Use
   this template"), clone it.
2. **Framework.** Copy the environment's graphite-configuration `.tar` into `images/`,
   then run `mdt init`: it fills `Framework/OOTB` from the image and copies it to
   `Framework/CUSTOMIZED`.
3. **Apps.** For each app, download the **pristine** app from the MAS Configuration app,
   then run `mdt ootb app <download.zip> --as TECHMOBILE`. That fills
   `MobileApps/OOTB/TECHMOBILE` and copies it to CUSTOMIZED.
   - Already have a customized version? Replace `MobileApps/CUSTOMIZED/TECHMOBILE`
     with it.
   - mdt warns if a download isn't really pristine (`*.delta.xml` files, or `src/`
     differs from `ibm-config/src/`).
4. **Commit the starting point.** Run `git add -A && git commit -m "Baseline"`, then
   `git tag ootb-<version>`.

Also: `mdt app import <id>` copies an app from the connected device, and `mdt env detect`
copies the build env (`VITE_MAS_DOMAIN`, ...) from the device. Without a device, use
`mdt env set ...`.

## Daily work

- Edit `Framework/CUSTOMIZED/...` and `MobileApps/CUSTOMIZED/<APP>/...`, and commit as
  usual. Never edit OOTB by hand.
- `mdt build techmobile --debug` builds unminified with source maps. Release builds
  (without `--debug`) use the same steps and tools as the Configuration app.
- `mdt deploy techmobile --debug` builds, backs up, pushes to the device and reloads
  the app.
- `mdt diff` shows what you changed vs IBM and writes `patches/framework.patch`,
  `patches/techmobile.patch`.

Builds compile only the framework files where CUSTOMIZED differs from OOTB (with
the image's Babel) and overlay them on IBM's compiled package. The framework is bundled
into every app, so rebuild every app that should carry a framework change.

## Maximo update

1. **Drop in the new OOTB.** Don't commit yet.
   - `mdt ootb framework images/<new>.tar` replaces Framework/OOTB.
   - `mdt ootb app <new download>.zip` replaces MobileApps/OOTB/<APP>, once per app.
2. **Merge.** Run `mdt upgrade --dry-run` to see what will happen, then `mdt upgrade` to
   merge into CUSTOMIZED. The base of the merge is OOTB at the last commit.
3. **Resolve conflicts.** Search for `<<<<<<<`: three sections show CUSTOMIZED, the old
   OOTB and the new OOTB. For conflicting `app.xml` files, the report also points to a
   merge by IBM's own XML-aware tool, a useful second opinion.
4. **Build and test.** `mdt build` refuses while conflict markers remain, or while OOTB
   changed but wasn't merged.
5. **Commit and tag.** `git add -A && git commit -m "Upgrade to ..."`, then
   `git tag ootb-<version>`.

What `mdt upgrade` does with each file IBM changed:

| your side | result |
|---|---|
| you never changed it | IBM's new version |
| IBM's change is already in yours, or IBM didn't change it | yours |
| both changed, different places | merged (`git merge-file`) |
| both changed the same lines | conflict markers |
| IBM added / deleted it | added / deleted (kept and flagged if you customized a deleted file) |

The report goes to `.mdt/upgrade/<time>/REPORT.md`. IBM's XML tool isn't used for the
result itself, because it rewrites every attribute's order (thousands of changed lines in
a diff).

## Driving the app (you or an agent)

```powershell
mdt ui                          # visible controls as [ref] "label" #id (in: card text) + page text
mdt tap 4                       # or tap "Razširi" | --id "cardtemplate1[9]_chevron" | --selector css
mdt type 7 "pump" --enter       # key back | wake | enter ...    scroll down
mdt wait "Delovni nalog"        # until text (or --selector) shows up, --gone for the reverse
mdt state                       # current page, page stack, datasources (debug builds)
mdt console --errors            # JS errors, including ones logged before attaching
mdt screenshot                  # PNG (screen must be on)
```

Debugging by hand: open `chrome://inspect` in Chrome on the PC and inspect *Navigator*.
The app runs in the `navigator_Iframe` frame.

## Agent permissions

`AGENTS.md` holds the default policy; `mdt policy set key=value` (in your own terminal)
writes your per-clone choice to `AGENTS.local.md`.

| key | levels | covers |
|---|---|---|
| `device` | off / read-only / **ask** / auto | push, deploy, restore, reload, restart |
| `device-ui` | off / read-only / **ask** / auto | tap, type, key, eval |
| `device-data` | **ask** / auto | saving, submitting, syncing records while testing |
| `framework` | read-only / **ask** / auto | edits in `Framework/CUSTOMIZED` |
| `apps` | read-only / ask / **auto** | edits in `MobileApps/CUSTOMIZED` |
| `uploads` | never / **ask** | upload, publish, image pushes |

OOTB edits and policy changes always need your approval. In Claude Code a PreToolUse
hook enforces this (`mdt/agent/policy-hook.mjs`; `.claude/settings.json` registers it).
mdt also refuses blocked actions when run non-interactively.

## Shipping to production

`mdt package techmobile` writes `dist/techmobile/<version>-<time>/`:

| file | what | how it gets to Maximo |
|---|---|---|
| `techmobile__ver-<v>.zip` | the app binary devices download, framework compiled in | `mdt upload techmobile --target uat` (or any REST client: `--dry-run` prints the request) |
| `TECHMOBILE.zip` | sources in the MAS Configuration app's upload layout (`TECHMOBILE/...`; the name must be the upper-case app id) | Configuration app, Upload. The pod rebuilds it with **its** framework |
| `app-source.zip` | raw source archive (also inside the binary) | archive |
| `release.json` | versions, image, commit, sha256 | |

Test the exact release first: `mdt push techmobile --release`. Uploads go to the Maximo
**server** (`targets/<name>.json`, see `targets/example.json`); devices pick the
new version up on their next update check.

Framework changes inside MAS itself (when people also publish from the Configuration app):
`mdt image build --save` bakes Framework/CUSTOMIZED into a copy of the IBM image (verified
by sha256, saved as a docker-archive tar). Running it on the cluster needs an image
override that MAS's operator accepts. IBM support won't cover a modified framework.

## More

- `docs/internals.md`: how the image, the build, the device and the upload work.
- `CLAUDE.md`, `.claude/skills/`: `mdt-setup`, `mdt-upgrade`, `mdt-framework`,
  `mdt-device`, `mdt-test`, `mdt-release`.
- `mdt help`: every command.
