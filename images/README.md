# images/

Put the IBM `mas/graphite-configuration` image here as a `docker save` tar
(the "graphite pod" image of the MAS environment), then run `mdt init`.

- `mdt init` (first time) extracts `Framework/OOTB` from the newest tar here and
  records it in `Framework/ootb.json`; builds use that image.
- When Maximo is updated: copy the new tar in, `mdt ootb framework images/<new>.tar`,
  then `mdt upgrade` (see the README, "Maximo update"). Old tars can go once the
  upgrade is committed.
- Tars are git-ignored (3.5 GB each). On another machine, copy the tar that
  `Framework/ootb.json` names into `images/`; mdt loads it into Podman when needed.

Getting the tar from a cluster: find the pod that runs `mas/graphite-configuration`,
read its image reference, then pull and save it with a registry login that can read
IBM's entitled registry (or your mirror):

```sh
oc get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\t"}{.spec.containers[*].image}{"\n"}{end}' | grep graphite-configuration
podman pull <image ref>
podman save --format docker-archive -o images/graphite-configuration-<version>.tar <image ref>
```
