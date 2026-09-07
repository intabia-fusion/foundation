# Desktop auto-update system

Chain: app (`desktop/src/main/updater.ts` + `start.ts`) -> electron-updater generic provider
-> `https://<host>/_dist` served by `desktop-package/src/distServer.ts` (docker `intabiafusion/desktop-distro`)
-> artifacts + `latest*.yml` produced by electron-builder in the tag-only `dist-build` CI job.

## Root causes found 2026-09-07

### Multi-range requests were answered with 416
`electron-updater`'s generic provider sets `isUseMultipleRangeRequest: true` for every URL that is
not `s3.amazonaws.com` (`providerFactory.js`). `DifferentialDownloader` then batches up to 1000
ranges into one `Range: bytes=a-b, c-d, ...` header and expects `multipart/byteranges`.
The dist server rejected any comma with 416, so differential updates never worked on
Windows/Linux - every update pulled the full ~230 MB installer. Verified live before the fix:

    curl -H 'Range: bytes=0-99, 200-299' .../Platform-macos-*.zip.blockmap  ->  416

`distServer.ts` now emits real `multipart/byteranges`. The format is asserted against
electron-updater's own `DataSplitter` in `desktop-package/src/__test__/distServer.test.ts`, so an
electron-updater upgrade that changes the wire format fails the test rather than the users.

### A failed read killed the whole server
`createReadStream(file).pipe(res)` had no `'error'` handler and there was no
`process.on('uncaughtException')`. A client abort is survivable on Node 24, but an open/read
failure (EACCES, ENOENT, **EMFILE** under load - the server streams 230 MB files with no
concurrency limit) is not: unhandled `'error'` exits the process and every concurrent download
dies with it. Reproduced standalone before fixing. `pipeToResponse` now handles it.

### The default update channel did not exist
`start.ts` fell back to channel `platform` when config set none. No server publishes
`platform.yml` (checked prod and stage - both 404; both serve `latest.yml`), and
`dev/prod/public/config.json` (stage) sets no channel, so stage silently never updated.
Default is now `latest` in `desktop/src/main/updateChannel.ts`.

Production channel is not read from `dev/prod/public/*.json` at all: the helm chart
(`fusion-deployment/charts/fusion/templates/front/front.yml`) hardcodes
`DESKTOP_UPDATES_CHANNEL=latest` / `DESKTOP_UPDATES_CHANNELS=latest` into the front pod. The
`platform` / `front` values still sitting in `config-huly.json` / `config-worker.json` are dead.
The chart values do not expose the channel, so a per-stand channel means editing that template.

## electron-builder 26 in a Rush repo

26 detects the package manager itself: `packageManager` field -> lock file next to the package ->
environment. A Rush project has no lock file of its own, so it fell back to **npm** and ran
`npm ls` over `common/temp` - which dies (`Node module collector process exited with code null`,
npm `ELSPROBLEMS` / V8 OOM). Fix: `"packageManager": "pnpm@<rush.json pnpmVersion>"` in
`desktop-package/package.json`. Keep the two in sync.

## Versions and deliberate exclusions

Upgraded: electron 40 -> 44, electron-builder 25 -> 26, electron-updater 6.3 -> 6.8.9,
electron-log 5.4.4, electron-store 8 -> 11, electron-context-menu 4 -> 5.

- `electron-store` 9+ and `electron-context-menu` 4+ are pure ESM. Webpack bundles them into
  `dist/main/electron.js` fine; only `settings.test.ts` touches electron-store and it mocks it.
- `@electron/notarize` left at 2.3.2. v3 is ESM-only, only affects mac notarization, has no
  security fix, and can only be exercised in the signed tag build.
- electron 42 moved macOS notifications to `UNNotification`: unsigned mac builds now emit
  `failed` instead of showing a notification. Signed builds are unaffected.
- electron 42 no longer downloads its binary in `postinstall`; it downloads on first `bin` run.

## Testing

Update-system tests are tag-only by design: `desktop-package` has no `_phase:test`, so
`rush fast-build:test` skips it. The tag `dist-build` job runs `rushx test` in `desktop-package`
before building, then `scripts/verify-manifests.js deploy latest` after `electron-builder`.

`verifyManifests` checks each `latest*.yml` parses, names files that exist, and that every
`sha512` matches the artifact on disk - a stale checksum makes the app download an update it can
never install, which looks exactly like flaky updates.

Local partial build:

    cd desktop-package
    rushx dist-local --macos --arm64
    node scripts/verify-manifests.js deploy latest --suffixes=-mac
