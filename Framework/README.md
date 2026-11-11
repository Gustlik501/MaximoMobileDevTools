# Framework/

| folder | what | who changes it |
|---|---|---|
| `OOTB/` | IBM's framework sources (`maximo-js-api`, `react-components`, ...), rebuilt from the source maps inside the graphite-configuration image | only `mdt ootb framework <image.tar>` |
| `CUSTOMIZED/` | your framework: starts as a copy of OOTB, you edit it | you |
| `ootb.json` | which image OOTB came from (builds use that image) | `mdt ootb framework` |

Builds compile only the files where CUSTOMIZED differs from OOTB and overlay them
on IBM's compiled package. `mdt diff framework` writes `patches/framework.patch`.

On a Maximo update: `mdt ootb framework images/<new>.tar` replaces OOTB, then
`mdt upgrade` merges IBM's changes into CUSTOMIZED (base = OOTB at the last commit).
