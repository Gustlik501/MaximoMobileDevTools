# targets/

Upload targets for `mdt upload` / `mdt publish`: one JSON file per Maximo
environment, `targets/<name>.json`. They hold credentials and are git-ignored
(only `example.json` and this README are tracked).

Auth, pick one:
- `apikey`: Maximo API key, uploads to `/<context>/api/os/OSLCMAFAPPDATA`
- `userName` + `password`: `maxauth`, uploads to `/<context>/oslc/os/OSLCMAFAPPDATA`
- `accessToken`: MAS access token, uploads through `/graphite/configtool/packages/<app>/binary`
  (needs `workspaceid`), like the Configuration app does

`insecure: true` skips TLS verification (self-signed test clusters only).
