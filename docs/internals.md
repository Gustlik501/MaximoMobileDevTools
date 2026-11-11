# How it works: image, build, device, upload

Findings from taking apart `mas/graphite-configuration` 2.5.15-29871 and a
debuggable Maximo Mobile 1.0.14 on Android 16. Versions move with every MAS
update; the structure has been stable.

## The graphite-configuration image

`docker save` tar, UBI8, Node 20, runs as user `wiotp`, port 9443. It's the backend
of the MAS **Configuration** app (app configuration / mobile deploy):

| path | what |
|---|---|
| `/graphite/packages/config-server/src` | Express server (minified). `BaseService.js`, `MASService.js` hold the build/publish logic |
| `/graphite/packages/config-server/client/build` | the Configuration app UI |
| `/graphite/scripts/graphite-tools.js` | CLI the server shells out to: `download`, `build`, `build:production`, `package`, `upload`, `diff`, `apply` |
| `/graphite/node_modules` | the whole toolchain (1.6 GB layer) |
| `/graphite/.workspace/<user>/<app>` | where the server keeps downloaded app sources |
| `/usr/local/bin/graphite-configuration-start.sh` | entrypoint (supervisor); copies config into writable overlays on read-only filesystems, injects `window.IBM_MAS_CONFIG` |

Framework and tools in `/graphite/node_modules/@maximo/` (2.5.15):
`maximo-js-api` 3.2.825, `react-components` 3.2.825, `maximo-library` 3.2.825,
`map-component` 3.2.48, `app-processor` 3.2.825, `maxdev-cli` 4.1.10,
`graphite-cli` 4.0.19 (Vite 8 + rolldown).

### How the config tool builds an app

```
cd /graphite/.workspace/<user>/<app>
yarn labels                                   # maxdev-cli localize -> src/i18n/labels.json
node graphite-tools.js build:production       # env CI=true GRAPHITE_RELEASE=true PUBLIC_URL=./
   maxdev-cli build --in ./src/app.xml --out ./build/app/src/ --update-ids --copy   # app.xml -> React
   cd build/app && graphite-cli build                                              # Vite -> build/app/build
node graphite-tools.js upload ...             # maxdev-cli upload-app (re-runs package-app -v <app.xml version>)
```

- No `yarn install`: apps resolve everything from the image's `/graphite/node_modules`.
  Versions pinned in an app's `package.json` are ignored.
- `CI`/`GRAPHITE_RELEASE` = minified, no source maps, and no `__graphite_preview` block
  in index.html. Without them: `GRAPHITE_SOURCEMAP=true GRAPHITE_MINIFY=false` give a
  debuggable bundle.
- `VITE_*`, `REACT_APP_*`, `GRAPHITE_APP_*` env vars are baked into
  `assets/process-polyfill-*.js` as `process.env`. The MAS pod sets
  `VITE_ROUTING_MODE`, `VITE_MAS_DOMAIN`, `VITE_ROOT_PATH`; the image sets
  `REACT_APP_CONFIG_VERSION/RELEASE`. `maximo-js-api` reads `VITE_ROOT_PATH` and
  `window.IBM_MAS_CONFIG`.
- `graphite-cli` loads `<project>/graphite.dev.config.mjs` (if present) and calls its
  `defineConfig(viteCfg)`: a supported hook to change the Vite config.
- `package-app` zips `build/app/build` + `app-source.zip` (the project minus
  build/, node_modules/, .git, *.md, tests, credentials; see `.graphiteignore`) into
  `<app>__ver-<version>.zip`, and writes `ibm-config/src/app-build-manifest.json`.

### Framework sources

Every `build/ejs/**/*.js` of `maximo-js-api`, `react-components` and `map-component`
ships a `.js.map` with **one source and its full `sourcesContent`** (IBM's original
file, LF, modern JS + JSX in `.js`, class fields, no TypeScript, no decorators).
IBM compiled them with Babel: preset-env (ES5 classes, inlined helpers) +
preset-react automatic runtime (`react/jsx-runtime`), ES modules, inline maps. Babel
only added helper imports; it didn't rewrite imports. Non-JS assets (`.json`,
`.png`, `.css`) sit next to the JS in `build/ejs`.

`maximo-js-api` has an `exports` map (`.` plus `./build/LookupManager`,
`./build/Constants`, `./build/util/Factory`, `./build/test/MockWindow`, `./build/*.json`).
Generated app code deep-imports `@maximo/react-components/build/ejs/...`. This is
why mdt **overlays compiled files in place** instead of aliasing packages: every
importer keeps resolving the same paths, so there's one framework instance.

The image also has `@babel/core`, `@babel/preset-env`, `@babel/preset-react`, which
`compile-framework.cjs` uses (target Chromium 90: native classes/async, which
interoperate with IBM's ES5 classes).

## Maximo Mobile on the device

- Package `com.ibm.iot.maximo.mobile` (MAS) or `com.ibm.iot.maximo.mobileeam` (EAM).
  Cordova shell, WebView (Chromium), pages served from
  `https://com.ibm.iot.maximo.mobile/__cdvfile_files__/www/apps/<app>/index.html`.
- App bundles: `/data/data/<pkg>/files/www/apps/<app>/` = the unzipped
  `<app>__ver-x.zip` (index.html, assets/, js/, data/, i18n/, build.json,
  manifest.json, app-source.zip) **plus** the shell's `cordova.js`,
  `cordova_plugins.js`, `plugins/` (not in the zip).
- New versions are unzipped **over** the old folder (old hashed assets stay). The
  shell only downloads when the server version changes, so locally pushed files
  survive until the next server deploy.
- `navigator` is the shell app; it shows the other apps in
  `<iframe id="navigator_Iframe">`. Each app bundles its **own copy of the
  framework**. Apps on one device can come from different toolchains
  (`build.json` → `appProcessorVersion`).
- Offline data: `databases/<hash>.db` (large, encrypted JSONStore); left alone.
- A **debuggable** APK (`dumpsys package` → `pkgFlags=[ DEBUGGABLE ...]`) allows
  `run-as <pkg>` (read/write the sandbox) and exposes `webview_devtools_remote_<pid>`
  (`chrome://inspect`, or CDP via `adb forward`). Play Store builds allow neither.
- `adb exec-out run-as <pkg> cat|tar ...` is binary-safe for pulls; `adb exec-in
  run-as <pkg> sh -c 'cat > cache/x'` streams files in. Device has toybox `unzip`,
  `tar`, `sha256sum`.
- Navigator also ships `js/preview-client.js`: `preview.preview(url, appId, {full})`
  fetches a zip from `<url>/preview?clientId&appId&mode=full|minimal` (ContentSync
  merge into `www/apps/<appId>`) and reloads. maxdev-cli's server side
  (`preview-middleware.js`) still expects the old CRA layout and isn't wired into
  graphite-cli 4. mdt uses run-as instead.

## Driving the app (mdt ui / tap / type / state)

- mdt forwards `webview_devtools_remote_<pid>` to a local port, picks the Navigator
  page target and evaluates JS there. The app document is reached through
  `#navigator_Iframe`'s `contentDocument` (same origin). Clicks are CDP
  `Input.dispatchMouseEvent` at the element's centre (iframe offset added), text
  goes in via `Input.insertText`, Android back/wake via `adb shell input keyevent`.
- Graphite renders app.xml ids as DOM ids (`cardtemplate1[9]_chevron`,
  `<ds>_searchbuttongroup_...`): stable targets. Button text often sits in a
  non-standard `label=""` attribute; icons are `<svg aria-label>` or class
  `Carbon:<name>`. WO cards are `role=tabpanel` elements whose id is the WO id.
- The app instance isn't global (`appContext.currentApp` is never set in 3.2.825).
  `AppSwitcher.get().currentApp` holds it; debug builds append
  `mdt/container/test-hook.js` to the compiled `app/AppSwitcher.js` in the build
  container, which exposes it as `window.__mdt.app` (`currentPage`, `findDatasource()`,
  `datasource.state.{itemCount,totalCount,loading,error}`).
- `Runtime.enable` replays earlier console messages, so `mdt console` also shows
  errors from app start.
- `screencap` is black while the screen is off (`dumpsys power` → `mWakefulness`),
  and `Page.captureScreenshot` hangs then. DOM, state and console work regardless.

## Upload endpoints (maxdev-cli upload-app)

- API key / user+password (Manage >= 7.6.1.3): `PUT
  <proto>://<host>:<port>/<context>/{api|oslc}/os/OSLCMAFAPPDATA?appid=<app>&action=wsmethod:uploadFile&version=<v>`
  (`&apikey=` or header `maxauth: base64(user:pass)`), body = zip.
- MAS access token: `POST <proto>://<host>[:port]/graphite/configtool/packages/<app>/binary?workspaceId=..&appid=<mas-id>&appDesc=<title>&version=<v>`,
  header `x-access-token`. `<mas-id>` is the `mas-id` attribute of app.xml (`manage`).
- `<v>` is the raw app.xml version (`9.2.71.0`), which also names the zip.
- `upload-app --skip-zip` doesn't work: its argument check only looks at the first
  CLI argument, so it always re-packages. `mdt upload` sends the packaged zip itself.
- The Configuration app's own upload accepts single source files or `<APP>.zip`
  containing `<APP>/...` (the project; the name must equal the pod's app name, the
  upper-case app id as in its downloads: `TECHMOBILE.zip`). It unzips into
  `<workspace>/<user>/temp-upload/`. If a previous upload left that folder undeletable
  (restrictive folder permissions in the zip), every later zip upload fails with "Could not
  remove temp-upload directory after multiple attempts". Renaming the folder from the pod
  terminal clears it. mdt builds this zip with normal permissions and no owner ids (`zip -X`). It replaces files in its workspace copy; the
  pod then builds with **its** framework.

## Upgrades: OOTB / CUSTOMIZED merge

- `mdt upgrade` merges per file with base = `git show <base>:<OOTB path>` (default HEAD),
  theirs = OOTB in the working tree, ours = CUSTOMIZED, using
  `git merge-file -p --diff3`. Text is compared and merged with CRLF normalized to LF.
  An OOTB tree with no files at the base counts as a first import, not an upgrade.
- IBM's XML merge engine is in the image:
  `/graphite/graphite-app-diff-tools/bin/graphite-app-diff-tools diff -b<orig> -m<modified> -t<delta>`
  and `apply -t<delta> -i<new base> -o<out> -f` (Java; `graphite-tools.js diff|apply`
  wraps it; `*.delta.xml` in Configuration-app sources come from it). It works per Graphite
  element/attribute. Round trip on TECHMOBILE's app.xml (IBM base -> customized ->
  re-applied) is semantically identical (4614 elements), but it drops XML comments
  here and there and **rewrites attribute order and formatting** (about 4,000 of 6,555
  lines differ textually). So mdt uses it only as a second opinion for conflicting XML.
  In a test, it correctly combined an IBM attribute and a customer attribute added to
  the same element, where the text merge conflicted.
- Guards: `mdt build` refuses while OOTB differs from HEAD without a recorded merge
  (`.mdt/upgrade/state.json` holds a hash of the merged OOTB), and while
  `<<<<<<<`/`>>>>>>>` markers exist in CUSTOMIZED.
- maxdev-cli loads `@maximo/maximo-js-api` in Node (`build/commonjs`) while generating the
  app, and mdt compiles customized framework files into that build too. Module-level
  `window` access throws there, and the failure surfaces as
  `No Transformer for maximo-datasource` (the transformer's import chain fails).

## Gotchas

- Windows bind mounts reject chmod/utime: unzip inside the container, then `cp`.
- Git Bash rewrites `/paths` passed to native tools (MSYS); mdt spawns podman
  directly from Node. GNU tar from Git Bash can't open `C:\` paths; use
  `%SystemRoot%\System32\tar.exe`.
- Line endings: `.gitattributes` keeps everything LF in the repo; mdt normalizes CRLF
  when importing OOTB apps and when comparing/merging, so a CRLF checkout of a file
  doesn't count as a customization. On Windows, git ignores letter case: an ignore
  rule `framework/` also hides `Framework/`.
- Debug bundles are about 45 MB of JS + a 105 MB map. Fine for adb, too big to publish.
- MAS references the graphite-configuration image by digest and the operator
  reconciles its deployment. Running a patched image needs an override mechanism on
  the cluster.
