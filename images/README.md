# images/

Put the IBM `mas/graphite-configuration` image here as a `docker save` tar
(the "graphite pod" image of the MAS environment), then run `mdt init`.

- One tar = one **profile** (named after the image's `version` label, e.g. `2.5.15`).
- When Maximo is updated, drop the new tar in here and run `mdt init` again: the
  new profile gets its own framework sources and `patches/framework.patch` is
  applied to it. Switch with `mdt image use <profile>`.
- Tars are git-ignored (3.5 GB each). The tar is loaded into Podman once; after
  that mdt only reads its manifest.

Getting the tar from a cluster: find the pod that runs `mas/graphite-configuration`,
read its image reference, then pull and save it with a registry login that can read
IBM's entitled registry (or your mirror):

```sh
oc get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\t"}{.spec.containers[*].image}{"\n"}{end}' | grep graphite-configuration
podman pull <image ref>
podman save --format docker-archive -o images/graphite-configuration-<version>.tar <image ref>
```
