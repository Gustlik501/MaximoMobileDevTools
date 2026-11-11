---
name: mdt-test
description: Verify a Maximo Mobile change on the connected device by driving the app with mdt - build and push a debug build, navigate with tap/type/key, read the screen with mdt ui and screenshots, check app state (current page, datasources) and console errors, and report pass/fail. Use when the user asks to test, try out, reproduce or check something on the device or tablet, or to make a change and confirm it works.
---

# Testing a change on the device

**First `mdt policy`.** It decides what you may do without asking:
`device` (push/reload), `device-ui` (tap/type/key/eval), `device-data` (saving
records). With `ask`, Claude Code prompts the user per call (the policy hook);
with `off`/`read-only`/`never` the call is blocked. Then stop and tell the user which
setting would allow it. Don't look for workarounds.

## Loop

```
mdt build <app> --debug            # ~70 s, run in background; debug builds carry the test hook
mdt push <app>                     # backup, install, reload the app in Navigator
mdt wait "<text on the page>"      # until the app has rendered
mdt ui                             # what's on screen: [ref] lines + page text
mdt tap <ref>                      # or: tap "Visible text" | --id <element id> | --selector css
mdt type <ref> "value" [--clear] [--enter]
mdt state                          # page name, page stack, datasources (items/total/loading/error)
mdt console --errors               # JS errors/warnings, incl. ones logged before you attached
mdt screenshot                     # PNG path: open it with the Read tool to look at it
```

1. Plan the check: which screen, which data, and what "works" looks like (text shown,
   datasource count, no console error, field value).
2. Build + push (needs `device`). The push reloads the app frame; check with
   `mdt ui` where it landed and navigate with `tap`.
3. After **every** tap: `mdt wait` for the expected text (or `--selector`), then `mdt ui`.
   Refs are renumbered on every `mdt ui`; don't reuse old refs.
4. Verify with facts: `mdt state` for page/datasource state, `mdt ui` text, `mdt eval`
   for one specific value, `mdt console --errors` at the end.
5. Report: what you did (steps), what you saw (quotes from ui/state), screenshots,
   errors, pass/fail. Say that the device now runs a pushed debug build, and that
   `mdt restore <app>` brings back the server version.

## Targeting elements

- `mdt ui` shows `[ref] kind "label" #element-id (in: card text)`. Graphite element
  ids come from app.xml and are stable across builds: prefer `--id` in repeatable
  steps (`mdt tap --id "cardtemplate1[9]_chevron"`).
- Icon buttons have names like `carbon:filter` / `Razširi`; the `(in: ...)` context
  tells you which list row or card they belong to.
- Text matches are case-insensitive, exact before partial; several hits ask for
  `--nth N`.
- `--app navigator` targets the Navigator shell (app tiles, side menu); the default is
  the app that is open. `mdt key back` = Android back button.
- If a click doesn't register: `mdt tap ... --js` (element.click()), or `--xy x,y`
  in device pixels from a screenshot as a last resort.
- Long lists: `mdt scroll down`, then `mdt ui` again.

## Data safety (real Maximo server)

Without `device-data: auto`, ask before taps that save, submit, change status,
approve, delete, start/stop timers, attach files or sync. Opening records,
searching, filtering, switching tabs and filling a form without saving are fine
under `device-ui`. Never log out, clear app data, uninstall or touch the offline
database.

## State and eval

`window.__mdt.app` (debug builds only, added in the build container) is the running
`Application`. `mdt state` summarizes it. For specifics:

```
mdt eval "__mdt.app.currentPage.name"
mdt eval "__mdt.app.findDatasource('woDetailResource').item?.wonum"
mdt eval "__mdt.app.findDatasource('todaywoassignedDS').state.totalCount"
```

`eval` runs in the app window and is a `device-ui` action. Keep it to reading values
unless the user wants otherwise. Datasource names are in the app's `src/app.xml`.

## When things don't line up

| symptom | do |
|---|---|
| screen off (screenshots refused) | `mdt key wake`; ui/state/console still work with the screen off |
| `app X is not open in Navigator` | `mdt ui --app navigator`, tap the app tile |
| `no test hook` | the installed build isn't an mdt debug build: `mdt deploy <app> --debug` |
| wait times out | `mdt screenshot` + `mdt console --errors` to see why |
| element not found | refs changed: `mdt ui` again; or the element is off screen: `mdt scroll down` |
