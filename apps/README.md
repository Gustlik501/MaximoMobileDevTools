# apps/

One folder per Maximo Mobile app project (a folder with `src/app.xml`), e.g.

```
apps/TECHMOBILE/    apps/NAVIGATOR/    apps/ASSETMOBILE/
```

Then run `mdt init` (or `mdt app add <folder>` for a folder somewhere else).

Where to get sources:
- Download from the MAS Configuration app (that zip contains `ibm-config/` with
  IBM's base XML, which upgrades need).
- `mdt app import <appId>` copies the `app-source.zip` of the version installed on
  the connected device (read-only on the device), e.g. `mdt app import navigator`.

Each app folder is best kept as its own git repo. The contents of apps/ are
git-ignored by this repo.
