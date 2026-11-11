# MobileDevTools

Dev workflow for Maximo Mobile apps and the Maximo framework, driven by the `mdt`
CLI (`mdt/mdt.mjs`). Builds run inside IBM's `mas/graphite-configuration` image via
Podman. README.md covers usage; docs/internals.md covers how the image, build,
device and upload work. Read internals.md before changing the tool.

## Running mdt

- PowerShell/cmd: `.\mdt.cmd <cmd>`; Git Bash: `./mdt.sh <cmd>`. Don't call podman
  by hand from Git Bash with `/container/paths` (MSYS rewrites them); let mdt do it.
- `mdt status` first, to see profiles (image versions), apps, build env, targets.
- Builds take about 30 s (release) or 70 s (debug); run them in the background if
  you need to keep working.

## Rules

- **The device is read-only unless the user asks** for a change on it. Read-only:
  `device`, `backup`, `app import`, `env detect`, `push --dry-run`. Writes:
  `push`, `deploy`, `restore`, `reload`. Run those only when the user asked for it in
  this conversation.
- **Uploads only when the user asks.** Run `mdt upload ... --dry-run` first and say
  which target (environment) it goes to. Never upload a debug build. `publish` = package + upload.
- Don't push images to registries or touch the cluster.
- Never commit `images/`, `apps/`, `framework/`, `out/`, `dist/`, `.mdt/`,
  `mdt.json` or `targets/*.json` (credentials). They are git-ignored; keep it that way.
- Framework edits go in `framework/<profile>/<package>/...`. Afterwards run `mdt framework save`
  so `patches/framework.patch` holds them, and suggest committing it. Keep LF line
  endings and IBM's formatting so the patch stays small.
- App edits go in the app's own folder under `apps/` (usually its own git repo).
- The framework is bundled per app: after a framework change, rebuild every app
  that should get it.

## Skills

- `mdt-setup`: new clone / new image / new app, prerequisites, init problems
- `mdt-framework`: finding and changing framework behavior, the patch, image upgrades
- `mdt-device`: build, push, reload, DevTools debugging, backup/restore
- `mdt-release`: package, upload to Maximo, Configuration-app source zip, patched image
