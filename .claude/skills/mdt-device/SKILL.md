---
name: mdt-device
description: Build a Maximo Mobile app with mdt and test it on an Android device over adb - push to a debuggable Maximo Mobile APK, reload the app inside Navigator, debug with Chrome DevTools (chrome://inspect), back up / restore the installed bundle, check what versions are on the device, or work out why the device doesn't show a change.
---

# Building and testing on a device

**The device is read-only unless the user asks for a change on it.** Read-only:
`mdt device`, `mdt backup <app>`, `mdt app import <app>`, `mdt env detect`,
`mdt push <app> --dry-run`. These write to the device: `push`, `deploy`,
`restore`, `reload` (reloads the app, unsaved form data is lost), `--restart`
(kills the app). Run them only when the user asked in this conversation.

## Loop

```
mdt device                      # APK version, DEBUGGABLE?, DevTools socket, app versions on the device
mdt build <app> --debug         # ~70 s; release build without --debug (~30 s)
mdt push <app> --dry-run        # show the plan
mdt push <app>                  # backup -> upload -> clean assets/ -> unzip -> verify sha256 -> reload
mdt deploy <app> --debug        # build + push
mdt reload <app>                # just reload (no re-login); --restart to restart the APK
mdt restore <app>               # oldest backup = what the server delivered; or restore <app> <file.tar>
mdt push <app> --release        # push the latest packaged release (dist/) to test it as-is
```

Backups go to `.mdt/backups/<app>/<time>.tar` before every push (skip with `--no-backup`).

## How it works

- App bundles live in `/data/data/com.ibm.iot.maximo.mobile/files/www/apps/<app>/`.
  mdt streams the zip into the app sandbox with `adb exec-in run-as`, unzips over
  the folder (the shell's `cordova.js`, `cordova_plugins.js`, `plugins/` stay) and
  checks the `index.html` hash.
- The app must already be installed on the device (log in once). Push replaces an
  installed app; it can't add one.
- Maximo Mobile only re-downloads when the server has a new version, so a pushed
  build stays until the next server deploy. If the device suddenly shows old code,
  the server shipped a new version: push again.
- Reload: mdt finds `webview_devtools_remote_<pid>`, forwards it, and over CDP
  reloads `#navigator_Iframe` (or the Navigator page itself for `navigator`). If it
  says "not open", the user has to open that app on the device first.

## Debugging

- Chrome on the PC: `chrome://inspect`, then the device, then **inspect** under
  *Navigator*. Pick the `navigator_Iframe` frame in the console's context menu to
  run code inside the app.
- Debug builds ship external source maps. App sources show as `src/...`; edited
  framework files as `framework/<pkg>/<file>`.
- Release builds are minified with no maps; use `--debug` while investigating.
- On-device bundle contents without changing anything: `mdt backup <app>`, then
  look inside the tar.

## Problems

| symptom | cause / fix |
|---|---|
| `run-as ... failed` | APK not debuggable, or wrong package (`device.package` in mdt.json; EAM uses `com.ibm.iot.maximo.mobileeam`) |
| `<app> is not on the device yet` | log in once so Maximo Mobile downloads it |
| reload "not open" | open the app in Navigator, or `mdt reload <app> --restart` |
| `no WebView DevTools socket` | the app isn't running: start it on the device |
| verification failed | the device rejected writes (storage full?); `mdt restore <app>` |
| works on device, not after publish | other apps/devices still have the server version; release via `mdt-release` |
