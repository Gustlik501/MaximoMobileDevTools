# MobileDevTools

A dev workflow for **Maximo Mobile** where both the **app sources** (TECHMOBILE,
NAVIGATOR, ...) and the **framework** (`@maximo/maximo-js-api`,
`@maximo/react-components`, ...) can be changed. Apps are built inside IBM's own
`mas/graphite-configuration` image, so the toolchain is exactly what MAS uses. You
can test on a device over adb, then ship to Maximo.

Clone it once per environment, drop in that environment's image and app sources,
and run `mdt init`.

```
mdt.cmd <command>     PowerShell / cmd          ./mdt.sh <command>    Git Bash / macOS / Linux
```

## Prerequisites

- **Node 22+**, **git**, **curl** (built into Windows 10+)
- **Podman** (Podman Desktop on Windows/macOS, with the machine created) or Docker
  (`"container": {"engine": "docker"}` in `mdt.json`)
- For device work: **adb** (platform-tools, or the one that ships with scrcpy) and a
  **debuggable** Maximo Mobile APK (`com.ibm.iot.maximo.mobile`). Play Store builds
  can't be pushed to.

`mdt doctor` checks all of it.

## New environment

```powershell
git clone <this repo> C:\work\CUSTOMER-mobile
cd C:\work\CUSTOMER-mobile
copy \\somewhere\graphite-configuration.tar images\     # IBM image of that MAS environment
xcopy /E \\somewhere\TECHMOBILE apps\TECHMOBILE\         # app sources (one folder per app)
mdt.cmd init
```

`mdt init` (safe to re-run any time):
1. checks the prerequisites (starts the Podman machine if needed)
2. loads every `images/*.tar` into Podman and registers it as a **profile**
   (named after the image version, e.g. `2.5.15`)
3. rebuilds the framework sources of each profile from the image into
   `framework/<profile>/` and applies `patches/framework.patch` if there is one
4. registers every app in `apps/`
5. reads the build env (`VITE_MAS_DOMAIN` etc.) from an app on the connected
   device, so builds match what the MAS pod produces (read-only)

No device yet? `mdt env set VITE_MAS_DOMAIN=<domain> VITE_ROUTING_MODE=subdomain VITE_ROOT_PATH=`.
Need Navigator's sources? `mdt app import navigator` copies them off the device.

## Daily loop

```powershell
mdt build techmobile --debug     # unminified + source maps (~1 min)
mdt push techmobile              # backup, push, verify, reload the app inside Navigator
mdt deploy techmobile --debug    # both in one go
mdt restore techmobile           # back to what the server delivered
```

Debugging: open `chrome://inspect` in Chrome on the PC, then click **inspect**
under *Navigator*. The app runs in the `navigator_Iframe` frame; with `--debug`
you get source maps, and edited framework files show as `framework/<pkg>/<file>`.

## Driving the app (you or an agent)

mdt can operate the app on the device through the WebView's DevTools connection,
so an agent can make a change, push it and check the result itself:

```powershell
mdt ui                          # visible controls as [ref] "label" #id (in: card text) + page text
mdt tap 4                       # or tap "Razširi" | --id "cardtemplate1[9]_chevron" | --selector css
mdt type 7 "pump" --enter       # key back | wake | enter | escape ...    scroll down
mdt wait "Delovni nalog"        # until text (or --selector) shows up, --gone for the reverse
mdt state                       # current page, page stack, datasources (debug builds)
mdt console --errors            # JS errors, including ones logged before attaching
mdt screenshot                  # PNG (screen must be on)
```

Debug builds get a small test hook in the build container (`window.__mdt.app` =
the running Application), which `mdt state` and `mdt eval` use. Release builds don't.

## Agent permissions

You decide what an agent may do. The block in **AGENTS.md** holds the defaults; your
own per-clone choice goes in **AGENTS.local.md** (git-ignored), most easily with:

```powershell
mdt policy                                        # show the effective policy
mdt policy set device=auto device-ui=auto         # let the agent push and click through tests
mdt policy set framework=read-only uploads=never  # framework only as suggestions, never upload
```

| key | levels | covers |
|---|---|---|
| `device` | off / read-only / **ask** / auto | push, deploy, restore, reload, restart |
| `device-ui` | off / read-only / **ask** / auto | tap, type, key, eval |
| `device-data` | **ask** / auto | saving, submitting, syncing records while testing |
| `framework` | read-only / **ask** / auto | edits under `framework/` |
| `apps` | read-only / ask / **auto** | edits under `apps/` |
| `uploads` | never / **ask** | upload, publish, image pushes |

`ask` means an approval prompt for every such action. In Claude Code this is enforced
by a PreToolUse hook (`mdt/agent/policy-hook.mjs`): `ask` makes Claude Code prompt
you even in auto mode, and `off`/`read-only`/`never` block the call. mdt also refuses
blocked actions when it runs non-interactively, which covers other agents too. In
your own terminal mdt never stops you.

**Install the hook once** (Claude Code won't let an agent install hooks itself):

```powershell
copy mdt\agent\claude-settings.json .claude\settings.json
git add .claude/settings.json; git commit -m "Enable the mdt agent policy hook"
```

`mdt doctor` / `mdt policy` warn while it's missing; `/hooks` in Claude Code shows it.

## Changing the framework

1. Edit files under `framework/<profile>/maximo-js-api/` or `.../react-components/`
   (more packages: `mdt framework extract --packages map-component`).
2. `mdt build` / `mdt deploy` pick the edits up: only changed files are recompiled
   (with the image's Babel) and overlaid on IBM's compiled package inside the
   throwaway build container.
3. `mdt framework status` shows what you changed. `mdt framework save` writes
   everything to **`patches/framework.patch`**. **Commit that file**: it's how
   framework changes survive a fresh clone and Maximo updates.
   `framework/` itself is a git-ignored working copy (IBM's code, per image version).

The framework is compiled **into every app bundle**. A change reaches only the apps
you rebuild with it.

## When Maximo is updated

```powershell
copy graphite-configuration-new.tar images\
mdt init                     # new profile, framework extracted, patches/framework.patch applied
mdt image use <new profile>
mdt framework status         # hunks that didn't fit are listed as *.rej: fix, delete .rej
mdt framework save           # the patch now matches the new version: commit
```

The old profile stays usable until `mdt image remove <profile> [--rmi]`.

## Shipping to production

`mdt package techmobile` makes a release build and puts everything in
`dist/techmobile/<version>-<time>/`:

| file | what it is | how it gets to Maximo |
|---|---|---|
| `techmobile__ver-9.2.71.0.zip` | the **app binary** devices download (Vite build + `app-source.zip`). Framework edits are compiled in | `mdt upload techmobile --target uat` |
| `techmobile.zip` | the **sources** in the layout the MAS Configuration app accepts (`techmobile/...`) | Configuration app, Upload. **The pod rebuilds it with its own framework** |
| `app-source.zip` | the raw source archive (also inside the binary) | for archiving / other tools |
| `release.json` | versions, image, patch sha, source git commit, sha256 of each file | |

Test the exact release on the device first: `mdt push techmobile --release`.

**`mdt upload`** sends the binary to the Maximo **server**, not to a device or the
APK. Devices get the new version on their next app update check / login. Targets
are `targets/<name>.json` (API key, user+password, or MAS access token; see
`targets/example.json`). `--dry-run` shows the request. `mdt publish` = package + upload.

**Uploading another way** (Postman, your own pipeline, a colleague with access):
send the binary zip with the same request `mdt upload --dry-run` prints. Don't
insert into the database directly: the REST endpoint is what the Configuration app
uses and keeps Maximo's app records consistent.

**Keeping framework changes in MAS itself:** if people also publish from the MAS
Configuration app, that pod rebuilds apps with the **stock** framework and your
changes disappear. `mdt image build --save` bakes `patches/framework.patch` into a
copy of the IBM image (verified file by file, saved as a docker-archive tar under
`dist/images/`). Push it to your registry and point the graphite-configuration
deployment at it. MAS pins the image by digest and the operator reconciles it, so
that needs whatever image-override mechanism your MAS version supports. IBM support
won't cover a modified framework, and every MAS update means the "When Maximo is
updated" steps plus a new `image build`.

## Layout

```
AGENTS.md           agent rules + default permission policy (AGENTS.local.md: per clone, ignored)
mdt/                tool (mdt.mjs CLI, lib/, container/ scripts for the IBM image, agent/ policy hook)
docs/internals.md   how the image, the build, the device and the upload work
patches/            framework.patch: your framework edits (tracked)
targets/            upload targets (only example.json tracked)
.claude/skills/     Claude Code skills for this workflow
images/  apps/      you put the IBM tar and the app sources here (ignored)
framework/          per-profile framework working copy (ignored, rebuilt by init)
out/ dist/ .mdt/    builds, releases, baselines, device backups (ignored)
mdt.json            this clone's state (ignored, rebuilt by init)
```

## With Claude Code (or another agent)

Open the clone in Claude Code. `AGENTS.md` (rules + permission policy, read by most
coding agents), `CLAUDE.md` and the skills in `.claude/skills/` (`mdt-setup`,
`mdt-framework`, `mdt-device`, `mdt-test`, `mdt-release`) explain the workflow, so
you can ask things like "set this environment up", "the WO list should show the
asset description, change it and test it on the tablet" or "package techmobile for UAT".
