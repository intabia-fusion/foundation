# UI Sanity testing using play-wright

## Prepare environment with docker to test final product.

Two variants, first use a local build and use an already build version.

### A local build

```bash
rush update
rush build
rush bundle
rush docker:build
./prepare.sh
```

### An already build version

```bash
./create-version-override.sh v0.7.309 # Will create a version override file.
./prepare-pg.sh # To prepare all stuff
./reset-version.sh # To go back to local build

# open http://localhost:8083
```

### Restore to pure DB

To purge content of sanity workspace following command could be used.

```bash
./restore-workspace.sh
```

## Prepare local dev environment

```bash
rush update
rush build
rush bundle
./create-local.sh
```

### Restore to pure DB for Local setup

To purge content of sanity workspace following command could be used.

```bash
./restore-local.sh
```

## Running UI tests

```bash
cd ./sanity
rushx uitest # for docker setup
rushx dev-uitest # for dev setup
```

## Debugging UI tests

```bash
cd ./sanity
rushx debug -g test-name # for docker setup
rushx dev-debug -g test-name # for local setup
```

## Capturing new testing scenarios

```bash
rushx codegen # for docker setup
rushx dev-codegen # for local setup
```

## AI bot tests

Two levels are configured in `tests/config-aibot.yaml`:

- **`low`** (default) — mock provider in echo mode: replies with the whole received context as
  markdown, so tests assert what actually reached the model. Offline, runs in CI.
- **`middle`** — a real local model via the `aibot_client_llm` clisr worker. Only the `@llm`
  suite uses it; without a model server the level simply has no worker.

Base tests need nothing extra — they are part of `rushx uitest`.

### Real-LLM suite (@llm)

1. Serve a mid-size model on the host over an OpenAI-compatible API at
   `http://localhost:8000/v1` (LM Studio, llama.cpp, vLLM). Override with `LLM_TEST_ENDPOINT`,
   `LLM_TEST_MODEL`, `LLM_TEST_API_KEY`.
2. The stand already runs `aibot_client_llm`; it idles until the endpoint answers.
3. Run:

```bash
cd tests/sanity
rushx run-uitests                 # whole @llm suite
rushx run-uitests -g 'factual'    # single test
```

Tests switch the workspace to `middle` through the ai-bot API (`POST /levels/workspace`,
owner or system token). Replies are not deterministic, so they assert behaviour (an answer
arrives, a fact is carried across turns), not exact text.

## Test authoring.

Please update all navigation with using PlatformURI for CI and dev environment compatible testing.

## Generate Allure

```bash
allure generate allure-results -o allure-report --clean
allure open allure-report
```
