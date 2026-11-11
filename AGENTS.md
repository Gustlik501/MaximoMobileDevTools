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
framework: ask      # read-only | ask | auto         editing framework sources (framework/)
apps: auto          # read-only | ask | auto         editing app sources (apps/)
uploads: ask        # never | ask                    mdt upload / publish, pushing images to a registry
```

| level | meaning |
|---|---|
| `off` | don't touch the device at all, not even to read |
| `read-only` | look only (`mdt device`, `ui`, `screenshot`, `console`, `state`, `logcat`, `backup`); no changes |
| `ask` | ask the user before each action of that kind and wait for an explicit yes |
| `auto` | go ahead without asking, then report what you did |
| `never` | not allowed; tell the user what they would have to do themselves |

Always free: reading files, `mdt build`, `mdt package`, `mdt framework status|diff|save`,
dry runs (`--dry-run`). Changing this policy, `.claude/settings*.json` or the
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
- Use mdt for device work, not raw `adb` (raw adb writes always need approval).
- `mdt push` backs up first; `mdt restore <app>` puts the server version back.
  Tell the user when the device runs a pushed (non-server) build.

## Code rules

- Framework edits only under `framework/<profile>/<package>/`, minimal, LF, IBM's
  formatting. Then run `mdt framework save` (writes `patches/framework.patch`) and suggest
  committing it. `framework: read-only` means suggest the change as a diff and don't
  apply it.
- App edits go in the app's own folder under `apps/` (usually its own git repo).
- The framework is bundled into each app: rebuild every app that should get a change.
- Never commit `images/`, `apps/`, `framework/`, `out/`, `dist/`, `.mdt/`,
  `mdt.json`, `AGENTS.local.md`, `targets/*.json`. Never print target credentials.
- Uploads: `--dry-run` first, name the target environment, never a debug build.
