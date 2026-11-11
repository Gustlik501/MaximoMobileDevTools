@AGENTS.md

## Claude Code specifics

- The permission policy above is enforced by the PreToolUse hook in
  `.claude/settings.json` (`/hooks` shows it). If the hook blocks a call, don't work
  around it: no other shell commands, no other file paths. Tell the user which
  policy key would allow it.
- When the hook asks, the user sees the prompt. Say in one line what you are about
  to do and why before the call.
- Run mdt with `.\mdt.cmd` (PowerShell) or `./mdt.sh` (Git Bash). Don't call podman
  by hand with `/container/paths` from Git Bash (MSYS rewrites them).
- Builds take about 30 s (release) or 70 s (debug); run them in the background
  when you have other work.
- Screenshots: `mdt screenshot` prints a PNG path; open it with the Read tool to see it.

## Skills

- `mdt-setup`: new clone / new image / new app, prerequisites, init problems
- `mdt-framework`: finding and changing framework behavior, the patch, image upgrades
- `mdt-device`: build, push, reload, DevTools debugging, backup/restore
- `mdt-test`: drive the app on the device to verify a change (tap, type, wait, state, console)
- `mdt-release`: package, upload to Maximo, Configuration-app source zip, patched image
