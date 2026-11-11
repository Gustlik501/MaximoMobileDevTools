---
name: mdt-upgrade
description: Bring a Maximo Mobile project onto a new IBM release - replace Framework/OOTB from a new graphite-configuration image and MobileApps/OOTB from new pristine app downloads, run the three-way merge into CUSTOMIZED (mdt upgrade), resolve conflicts in JS and app.xml, rebuild, test, commit and tag. Use when Maximo/MAS was updated, a new image or new app sources arrived, or upgrade conflicts need resolving.
---

# Upgrading to a new IBM release

Merge base = **OOTB as of the last commit**. The new release is dropped into OOTB
(working tree, not committed), and `mdt upgrade` merges the difference into CUSTOMIZED
file by file.

## Steps

1. Precondition: everything committed (`git status` clean). `mdt upgrade` refuses
   while CUSTOMIZED has uncommitted changes; otherwise the merge result couldn't be
   reviewed or undone.
2. Drop in the new OOTB. Don't commit yet.
   - Framework: `mdt ootb framework images/<new>.tar` replaces Framework/OOTB +
     `Framework/ootb.json`, so later builds use the new image.
   - Each app: `mdt ootb app <new pristine download>.zip --as <FOLDER>`. Mention any
     "not pristine?" warnings to the user.
3. `mdt upgrade --dry-run`: read the summary and `.mdt/upgrade/<time>/REPORT.md`, and
   tell the user what will happen (conflict count, files).
4. `mdt upgrade` writes CUSTOMIZED (policy: `framework` + `apps`).
5. Resolve each conflict (the next section), then `mdt status` (no markers left) and
   `mdt diff` (sanity check: customizations still there, nothing unexpected).
6. `mdt build <app> --debug` for every app (refused while markers remain or OOTB is
   unmerged), then test (the `mdt-test` skill, within the device policy).
7. Suggest: `git add -A && git commit -m "Upgrade to <version>"` and `git tag ootb-<version>`.
   The commit shows IBM's changes (OOTB) and the merged result (CUSTOMIZED) side by side.

Undo before committing: `git checkout -- Framework MobileApps && git clean -fd Framework MobileApps`
(only with the user's OK: it discards the new OOTB and the merge).

## What the merge does per file

| case | result |
|---|---|
| you never changed it | IBM's new version (`took-ibm`) |
| IBM didn't change it / IBM's change already in yours | yours (`kept-yours`) |
| both changed, separate places | merged (`merged`) |
| both changed the same lines | conflict markers (`conflict`) |
| IBM added a file | added; conflict if you had one with the same name |
| IBM deleted a file | deleted if you never changed it; otherwise kept and listed under **Review** |
| you deleted a file IBM changed | left deleted, listed under **Review** |
| binary changed by both | yours kept, IBM's copy in `.mdt/upgrade/<time>/ibm-new/` |

## Resolving conflicts

Markers (diff3 style):

```
<<<<<<< CUSTOMIZED
  project's version
||||||| OOTB <old commit>
  IBM's old version (what the project started from)
=======
  IBM's new version
>>>>>>> OOTB new
```

- Work out **what each side meant** (old vs new = IBM's intent; old vs CUSTOMIZED =
  the project's intent) and write a version that keeps both. Usually that means keeping
  the customization and re-applying it on IBM's new code. Don't just pick one side.
- `app.xml` conflicts: the report links `ibm-xml-merge/<n>/ibm-merged.xml`, IBM's
  XML-aware merge (the Configuration app's engine; merges per element/attribute). Use it
  to see the combined element, but copy only the resolved lines into CUSTOMIZED: that
  file has every attribute re-ordered.
- Look up why something was customized: `git log -p -- <CUSTOMIZED file>`, the
  project's notes, `patches/<app>.patch` from before the upgrade
  (`git show HEAD:patches/<app>.patch`).
- Unsure about intent: ask the user and show both sides. Don't guess on business logic.
- After each file: no markers left, and it still parses (for XML, the build checks it).

## Framework specifics

- Framework conflicts happen in files the project customized under `Framework/CUSTOMIZED`.
  After resolving, keep the edit minimal and in IBM's style.
- `maximo-js-api` also runs in Node at build time (`build/commonjs`): new or merged
  module-level code must not touch `window`/`document` unguarded. The build fails with
  "No Transformer for ..." otherwise (mdt prints a hint).
- Every app bundles the framework: rebuild all apps after a framework upgrade.
