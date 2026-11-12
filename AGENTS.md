# Agent instructions: MobileDevTools

This repo is a Maximo Mobile dev workflow driven by the `mdt` CLI (`mdt.cmd` on
Windows, `./mdt.sh` elsewhere). Builds run inside IBM's graphite-configuration
image. Usage: README.md. How the image, build, device and upload work:
docs/internals.md. Run `mdt status` and `mdt policy` before you start.

## Permission policy (the user decides)

What an agent may do without asking is set here. Defaults are below;
**`AGENTS.local.md` (git-ignored) overrides them for one clone**. The user writes
it with `mdt policy set key=value` in their own terminal. Agents never change
either file; asking the user to change it is fine.

```mdt-policy
device: ask         # off | read-only | ask | auto   push, deploy, restore, reload, restart on the device
device-ui: ask      # off | read-only | ask | auto   driving the app: tap, type, key, eval
device-data: ask    # ask | auto                     saving, submitting or syncing Maximo records while testing
framework: ask      # read-only | ask | auto         editing Framework/CUSTOMIZED
apps: auto          # read-only | ask | auto         editing MobileApps/CUSTOMIZED
uploads: ask        # never | ask                    mdt upload / publish, pushing images to a registry
```

| level | meaning |
|---|---|
| `off` | don't touch the device at all, not even to read |
| `read-only` | look only (`mdt device`, `ui`, `screenshot`, `console`, `state`, `logcat`, `backup`); no changes |
| `ask` | ask the user before each action of that kind and wait for an explicit yes |
| `auto` | go ahead without asking, then report what you did |
| `never` | not allowed; tell the user what they would have to do themselves |

**Reading files is never restricted.** `read-only` means "no changes": read, grep,
diff and compare anything (OOTB, CUSTOMIZED, framework, apps) without asking.
Only `device: off` also stops *reading the device*.

Always free: reading files, `mdt build`, `mdt package`, `mdt diff`, `mdt status`, dry
runs (`--dry-run`, incl. `mdt upgrade --dry-run`). `mdt upgrade` writes CUSTOMIZED and
follows `framework`/`apps`. Changing OOTB, this policy, `.claude/settings*.json` or the
hook always needs the user's explicit approval.

**Enforcement.** In Claude Code, `mdt/agent/policy-hook.mjs` (a PreToolUse hook in
`.claude/settings.json`) applies this block to every edit and shell command: `ask`
opens an approval prompt, `off`/`read-only`/`never` block the call. mdt itself
also refuses blocked actions when it runs non-interactively. Other agents must
follow this section themselves: for `ask`, ask in chat and wait.

## Testing on the device

The connected phone or tablet runs a real Maximo Mobile against a real Maximo
server (UAT or prod data).

- Loop: change, `mdt build <app> --debug`, `mdt push <app>`, then `mdt wait`, `ui`,
  `tap`/`type`, `state`, `console --errors`, `screenshot`, then report. The
  `mdt-test` skill has the details.
- Without `device-data: auto`, ask before anything that saves, submits, changes
  status, deletes, starts/stops timers or syncs. Navigating, opening, searching,
  scrolling and filling a form without saving are fine under `device-ui`.
- Never: uninstall the app, clear its data (`pm clear`), log out, delete the offline
  database, change device settings. Unsynced offline transactions would be lost.
- Prefer mdt for device work. Raw `adb` follows the same keys as mdt (reads:
  `device`, `shell input`: `device-ui`, anything else: `device`); uninstall, `pm clear`,
  `rm`, `settings put` and reboot always need approval.
- `mdt push` backs up first; `mdt restore <app>` puts the server version back.
  Tell the user when the device runs a pushed (non-server) build.

## Code rules

- Layout: `Framework/OOTB` + `MobileApps/OOTB/<APP>` are IBM's pristine sources;
  `Framework/CUSTOMIZED` + `MobileApps/CUSTOMIZED/<APP>` are the project's. Builds
  use CUSTOMIZED.
- **Never edit OOTB by hand.** It only changes through `mdt ootb framework|app` during a
  Maximo update, followed by `mdt upgrade` (the `mdt-upgrade` skill).
- Framework edits go in `Framework/CUSTOMIZED/<package>/`: minimal, LF, IBM's formatting
  (keeps upgrades mergeable). With `framework: read-only`, show the change as a diff and
  don't apply it.
- `maximo-js-api` is also loaded in Node at build time (`build/commonjs`): no module-level
  `window`/`document` access in framework code. Guard it with `typeof window !== 'undefined'`.
- The framework is bundled into each app: rebuild every app that should get a change.
- `mdt diff` shows everything customized vs OOTB (`patches/*.patch`).
- Never commit `images/`, `out/`, `dist/`, `.mdt/`, `mdt.json`, `AGENTS.local.md`,
  `targets/*.json`. Never print target credentials. The repo contains IBM code: it
  must stay private.
- Uploads: `--dry-run` first, name the target environment, never a debug build.
