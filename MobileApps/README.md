# MobileApps/

| folder | what | who changes it |
|---|---|---|
| `OOTB/<APP>/` | IBM's app sources as shipped (download from the MAS Configuration app on a release where the app is stock) | only `mdt ootb app <download>` |
| `CUSTOMIZED/<APP>/` | your app: what gets built, pushed and published | you |

The folder name (`TECHMOBILE`) must be the same on both sides; the app id comes
from `src/app.xml`. `mdt ootb app` creates CUSTOMIZED as a copy the first time.
`mdt diff <app>` writes `patches/<app>.patch`.

On a Maximo update: `mdt ootb app <new download>` replaces OOTB, then
`mdt upgrade` merges IBM's changes into CUSTOMIZED (base = OOTB at the last commit).
