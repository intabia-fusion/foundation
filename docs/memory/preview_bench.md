# Preview bench: what it measures and what to distrust

`pods/preview/src/__tests__/bench/` - `BENCH=1 npx jest src/__tests__/bench/sharp.bench.test.ts`.
Regular `rushx test` skips it.

## Why each config forks a process

`sharp.concurrency()` and `sharp.cache()` are process-global, and libvips never returns thread
stacks to the allocator. Comparing two settings inside one process measures the first one twice.
`workload.ts` is both a library and a child entrypoint (`require.main === module`), run through
`ts-node/register/transpile-only`.

## Findings that changed the picture

- **avif costs 5.2x webp** in CPU and 2.6x in RSS on real 1440x900 screenshots (23.8 vs 124
  renders/s, 635 vs 241 MB) for 10-30% fewer bytes.
- The format is chosen by the **client's** Accept order, not ours: `server.ts:90-97` breaks on the
  first entry present in `prefferedImageFormats`, so that list is only a membership filter. Chrome
  lists `image/avif` first, so Chrome traffic renders avif.
- A 64x64 thumbnail costs 91% of a 300x300 one (29.4 vs 32.3 ms) - the source decode dominates, the
  encode does not. "Small thumbnail is cheap" is false.
- `sharp.concurrency(1)` costs nothing in throughput at **any** parallelism (par=1/4/10, all within
  2%) and gives back 15-16% peak RSS, rising to 22% at 240 renders. Turning off the libvips cache
  adds nothing on top of that.
- Throughput plateaus at `RateLimiter(4)`; the pod's default 10 buys no throughput, only more
  concurrent buffers.
- **It matches prod.** Prod is ~445 MB per pod (3 pods, 1.31 GB total, which is easy to misread as
  one pod). Prod settings here give 318 MB at 60 renders and 351 MB at 240, still climbing - so the
  sharp defaults account for prod's number and there is no separate leak to hunt. `conc=1` moves a
  pod from 445 to roughly 355 MB. `MALLOC_ARENA_MAX` was only interesting while the number to
  explain looked like a gigabyte.

## Interleave the configs, do not run them in blocks

Run configs round-robin (A/B/A/B), not one config's runs back to back. In blocks the first config
eats the cold start and produces a monotone ramp that reads as a difference between configs - an
earlier run showed 40 -> 116 renders/s across five runs of one config. Interleaved on an idle
machine the spread drops to 1-4%. A local LLM alongside moved identical configs by up to 40%,
which is more than most deltas being measured.

`BENCH_SOURCES_DIR` points the bench at real uploads instead of generated fixtures. Generated ones
are 8x-upscaled noise plus grain - flat colour flatters every encoder, raw noise punishes them all,
and either makes the format comparison meaningless.
