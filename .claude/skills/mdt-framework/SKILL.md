---
name: mdt-framework
description: Change Maximo framework code (maximo-js-api, react-components, map-component) that a Maximo Mobile app like TECHMOBILE or NAVIGATOR bundles - behavior not configurable from app.xml or controllers, framework bugs, component/datasource/platform changes - in Framework/CUSTOMIZED, then build and verify. Also adding framework packages and reviewing framework customizations against OOTB.
---

# Changing the Maximo framework

```
Framework/OOTB/<package>/        IBM's sources for the image in Framework/ootb.json   (never edit)
Framework/CUSTOMIZED/<package>/  the project's framework: edit here
  maximo-js-api/      data/ (Datasource, adapters, LookupManager), app/ (Application, Page,
                      ChangesManager, AppSwitcher), platform/anywhere/ (Maximo Mobile:
                      DisconnectedDataAdapter, AnywhereDevice, MASAuthenticator ...),
                      platform/browser|mas/, device/, auth/, localize/, util/
  react-components/   ui/<Component>/ (Button, Card, Dialog, Table ...), layout/ (Page,
                      Templates, XMLCanvas, Login), app/ (Shell, Router), hooks/
```

More packages: `mdt ootb framework --packages maximo-js-api,react-components,map-component`
(re-extracts OOTB with the extra package and copies it to CUSTOMIZED if it's new there).

## Permission

`mdt policy` → `framework`: `read-only` = don't edit, show the change as a diff;
`ask` = the user approves each edit (Claude Code prompts); `auto` = edit, then report.
Before the first framework edit, say which files you'll change and why: framework
changes ship in every app and must be carried through every Maximo update.

## Before editing

- Prefer app-level changes when they can do the job: controllers, `AppCustomizations.js`
  and app.xml in `MobileApps/CUSTOMIZED/<APP>`.
- Find the code: Grep `Framework/CUSTOMIZED/`. For "what does this app.xml tag render":
  `mdt build <app> --debug`, then read `out/<app>/generated/` (the React code app.xml
  became, with its `@maximo/react-components` imports and props). Tag schemas:
  `/graphite/node_modules/@maximo/app-processor/lib/ejs/registry/<tag>.js` in the image.
- To watch it live: a debug build + `chrome://inspect`, or the `mdt-test` skill.

## Editing rules

- Minimal edits, IBM's formatting, LF: every changed line is a potential conflict on the
  next upgrade.
- No module-level `window`/`document`/DOM access in `maximo-js-api`. It's also loaded in
  Node at build time (`build/commonjs`) and the build fails ("No Transformer for ...").
  Guard with `typeof window !== 'undefined'`, or put the code inside functions.
- New files are fine (compiled like the rest). Deleting a file has no effect at build
  time (IBM's compiled file stays); neutralize code instead.
- Imports inside a package stay relative (`../util/Log`); other framework packages by
  their public name (`@maximo/maximo-js-api`).
- Modern JS + JSX in `.js`, compiled with the image's Babel for Chromium 90; no
  TypeScript, no decorators.

## Verify and review

```
mdt status                 # CUSTOMIZED: N changed vs OOTB
mdt diff framework --files # which files differ; patches/framework.patch has the diff
mdt build <app> --debug    # compile errors show as [framework] ERROR <file>: ...
```

To prove an edit landed, search `out/<app>/www/assets/index-*.js` for a string you added.
Commit framework changes like any code; the user decides when.

## How the overlay works

`mdt/container/compile-framework.cjs` compares each `Framework/CUSTOMIZED` file with
`Framework/OOTB` (ignoring CRLF), Babel-compiles changed/added JS and writes it over
`/graphite/node_modules/@maximo/<pkg>/build/ejs/<file>` (and the `build/commonjs` twin)
in the throwaway build container. Every importer keeps resolving the same path, so
there's never a second framework copy. More in docs/internals.md.
