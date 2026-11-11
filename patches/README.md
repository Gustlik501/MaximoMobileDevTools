# patches/

`framework.patch` holds **all your framework edits** as a unified diff against
IBM's sources, with `<package>/<file>` paths (e.g. `maximo-js-api/app/Application.js`).
This file is the source of truth; `framework/<profile>/` is only a working copy.

- `mdt framework save`  writes the working copy's edits here (then commit).
- `mdt framework load`  rebuilds the working copy from IBM sources + this patch.
- On a new image version `mdt init` applies it automatically. Hunks that no longer
  fit end up as `*.rej` files next to the sources; fix them, delete the `.rej`
  and run `mdt framework save` so the patch matches the new version.

If different environments need different framework edits, keep one branch per
environment.
