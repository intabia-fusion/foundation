# @typescript-eslint 6->8 fix patterns (batch1)

Fixed 49 error locations across 40 files (prefer-optional-chain, prefer-nullish-coalescing,
strict-boolean-expressions, no-unused-vars, no-base-to-string, no-empty-object-type,
no-for-in-array, no-misused-promises). Non-obvious findings:

- **`arr[i]` / `.find()[0]` don't type as `T | undefined`** (no `noUncheckedIndexedAccess`).
  So `x?.prop` on such a value collapses to plain `boolean`/whatever (TS proves it's never
  nullish), and adding `=== true` there triggers `no-unnecessary-boolean-literal-compare`.
  Only add `=== true`/`?? false` when the source is genuinely optional (function return type
  says `T | undefined`, a declared optional field, etc). Case: `server-plugins/time-resources/src/index.ts:190`.

- **`typeof x !== 'object'` does NOT narrow `unknown` to primitives.** TS narrows the negative
  branch to `{}`, which still trips `no-base-to-string` on `String(x)`. Workaround: explicit
  cast `String(x as string | number | boolean | bigint | symbol)` after the runtime check.
  See `stringifyValue` in `server-plugins/workflow-resources/src/post-functions/transforms.ts`
  and `safeStringify` in `services/ai-bot/pod-ai-bot/src/workspace/compaction.ts`.

- **`Array.isArray(x)` narrowing an already-narrowed `object` can still get flagged** by
  no-base-to-string on `String(x)` inside the true-branch (intersection-type quirk) - not worth
  fighting; if arrays are never realistically passed in, drop the special case and let them fall
  through to `JSON.stringify`.

- **Explicit `.toString()` and even `.toJSON()`-shaped fallbacks don't bypass no-base-to-string**
  either - the rule checks the resolved type, not the call form. Use a properly-typed method
  instead (e.g. yjs `YText.toJSON(): string` in `ydoc.test.ts` - both `toString()` and
  `toJSON()` return the same content at runtime for `YText`, but only `toJSON()` is typed).

- **`a !== undefined && b === a.c`** (property access on the *second* operand) is also caught by
  prefer-optional-chain in v8; fix is `b === a?.c`, not just leaving it - confirmed via eslint's
  own `--format json` suggestion output (`services/ai-bot/pod-ai-bot/src/__tests__/eval/cli.ts:529`).

- Useful debugging trick: `./node_modules/.bin/eslint --no-eslintrc --config .eslintrc.js <file> --format json`
  gives the exact autofix/suggestion text per error - much faster than guessing at the intended
  rewrite for prefer-optional-chain.
