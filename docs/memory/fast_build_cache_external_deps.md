# fast-build cache ignores external dependencies

`rush fast-build:docker` reported "from cache" and shipped an image whose `bundle.js` still had
the old code, after a `pnpm patch` of `kafkajs` had already been applied and `rush update` had
relinked the patched copy into `common/temp/node_modules`.

## Why

`foundations/utils/packages/platform-rig/bin/libs/cache.js` keys each phase in
`.fast-build-cache.json` on the package's own source hash plus the hashes of its **workspace**
dependencies. Nothing about `common/temp/node_modules` enters the key. So anything that changes
only external packages leaves every phase looking valid:

- `pnpm patch` / `common/pnpm-patches/*.patch`
- a version bump resolved through the lockfile
- a hand edit inside `common/temp/node_modules`

The `transpile` phase is unaffected in practice (types rarely change), but `bundle` inlines the
dependency's source into `bundle.js`, so a stale `bundle` phase silently ships old third-party
code into the image.

## What to do

Invalidate the two phases that embed dependency code, keeping the expensive TypeScript compile:

```sh
python3 - <<'PY'
import json, subprocess
files = subprocess.run(['find','pods','services','-name','.fast-build-cache.json',
                        '-not','-path','*/node_modules/*'], capture_output=True, text=True).stdout.split()
for f in files:
    d = json.load(open(f))
    ph = d.get('phases', {})
    if not any(k in ph for k in ('bundle', 'docker-build')):
        continue
    for k in ('bundle', 'docker-build'):
        ph.pop(k, None)
    json.dump(d, open(f, 'w'), indent=2)
PY
rush fast-build:docker
```

36 packages carry a `docker-build` phase; the rebuild took ~46 s with `transpile` still cached.

## Verify in the artifact, not in the build log

The build log says "from cache" either way. Check the bundle:

```sh
docker run --rm --entrypoint sh intabiafusion/transactor \
  -c 'grep -n -A 10 "scheduleCheckPendingRequests() {" /usr/src/app/bundle.js'
```

Same trap as the svelte front rebuild: a green build log is not evidence the change is in the
image.
