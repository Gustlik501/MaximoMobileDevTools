---
name: mdt-framework
description: Change Maximo framework code (maximo-js-api, react-components, map-component) that a Maximo Mobile app like TECHMOBILE or NAVIGATOR bundles - behavior not configurable from app.xml or controllers, framework bugs, component/datasource/platform changes. Also covers saving edits to patches/framework.patch, moving them to a new graphite-configuration image version, and resolving *.rej patch conflicts.
---

# Changing the Maximo framework

Framework sources are IBM's originals, rebuilt from the source maps in the image:

```
framework/<profile>/maximo-js-api/      data/ (Datasource, adapters, LookupManager), app/ (Application, Page,
                                        ChangesManager, ShellCommunicator), platform/anywhere/ (Maximo Mobile:
                                        DisconnectedDataAdapter, AnywhereDevice, MASAuthenticator ...),
                                        platform/browser|mas/, device/, auth/, localize/, util/
framework/<profile>/react-components/   ui/<Component>/ (Button, Card, Dialog, Table ...), layout/ (Page,
                                        Templates, XMLCanvas, Login), app/ (Shell, Router), hooks/
```

`<profile>` = active image version (`mdt status`). Add packages with
`mdt framework extract --packages map-component`.

## Before editing

- Prefer app-level changes when they can do the job: controllers and
  `AppCustomizations.js` in the app's `src/`, app.xml attributes. Framework edits
  ship with every rebuilt app and have to be carried through every Maximo update.
- Find the code: Grep in `framework/<profile>/`. For "what does this app.xml tag
  render": run `mdt build <app> --debug`, then look at
  `out/<profile>/<app>/generated/` (the React code app.xml became, with the
  `@maximo/react-components` imports and props). The tag schemas live in the image
  at `/graphite/node_modules/@maximo/app-processor/lib/ejs/registry/<tag>.js`
  (`podman run --rm <image> cat ...`, image id from `mdt status`).
- The framework runs inside each app bundle on the device. Debug it with a
  `--debug` build + `chrome://inspect` (see the `mdt-device` skill).

## Permission

`mdt policy` → `framework`: `read-only` = don't edit, show the change as a diff
the user can apply; `ask` = the user approves each edit (Claude Code prompts); `auto` =
edit, then report. Before the first framework edit in a conversation, say which files
you'll change and why; framework changes ship with every app.

## Editing rules

- Edit files in place under `framework/<profile>/<package>/`. Keep IBM's
  formatting and LF endings; change as little as possible (the patch has to survive
  upgrades).
- New files are fine (compiled like the rest). Deleting a file has no effect at
  build time (IBM's compiled file stays). Neutralize code instead.
- Imports inside a package stay relative (`../util/Log`). Importing another
  framework package uses its public name (`@maximo/maximo-js-api`).
- Code is modern JS + JSX in `.js`, compiled with the image's Babel for Chromium 90.
  No TypeScript, no decorators.

## Verify

```
mdt framework status                 # M/A files, patch state
mdt build <app> --debug              # compile errors appear as [framework] ERROR <file>: ...
```

To prove an edit landed, search the bundle for a string you added:
`out/<profile>/<app>/www/assets/index-*.js`. To see it work, test on the device
with the `mdt-test` skill (`mdt deploy <app> --debug`, within the `device` / `device-ui` policy).

## Keep the change

`mdt framework save` writes all edits to `patches/framework.patch` (paths like
`maximo-js-api/app/Application.js`). Suggest committing it. `framework/` is
git-ignored, so the patch is the only copy that survives a fresh clone.
Other commands: `framework diff`, `framework load` (baseline + patch, discards
unsaved edits after a check), `framework reset`, `framework apply <file.patch>`.

## New image version / conflicts

`mdt init` with a new tar in `images/` extracts the new sources and applies the
patch. Hunks that don't fit become `<file>.rej` next to the file
(`mdt framework status` lists them with `!`):

1. Read the `.rej` hunk and the new version of the file; re-apply the intent by hand.
2. Delete the `.rej` (and any `.orig`).
3. `mdt framework save` so the patch matches the new version, then commit.
4. Rebuild and retest every app that carries the change.

Compare IBM versions of a file directly:
`.mdt/baseline/<old>/<pkg>/<file>` vs `.mdt/baseline/<new>/<pkg>/<file>`.

## How the overlay works (for debugging the tool)

At build time `mdt/container/compile-framework.cjs` hashes each working-copy file
against `.mdt/baseline/<profile>/manifest.json`, Babel-compiles changed/added JS
and writes it over `/graphite/node_modules/@maximo/<pkg>/build/ejs/<file>` (and the
`build/commonjs` twin if one exists) in the throwaway container. Every importer
keeps resolving the same path, so there's never a second framework copy. More in
docs/internals.md.
