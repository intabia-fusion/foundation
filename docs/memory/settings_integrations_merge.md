# Settings: apiKeys + webhooks merged into one "Integrations" category (FUSIO-1151)

## Model
- `models/setting/src/index.ts`: single `WorkspaceSettingCategory` doc, `name: 'integrations'`, `role: AccountRole.User`,
  reuses `setting.ids.ApiKeys`/`setting.component.ApiKeys` (repointed to the new merged component) and
  `setting.string.Integrations` (was already used by the unrelated account-level "Integrations" - external
  OAuth connections - `SettingsCategory` doc; different class, different sidebar, intentional label reuse).
- Deleted `setting.ids.Webhooks`/`component.Webhooks`/`string.Webhooks` and `string.ApiKeys` (bare) - all became
  unused; grep-confirmed no other reference before deleting.

## Component
- `plugins/setting-resources/src/components/IntegrationsSettings.svelte` replaces `ApiKeysSettings.svelte` +
  `WebhooksSettings.svelte`. Outgoing section rendered only `{#if isOwner}` (same `hasAccountRole` check
  `ApiKeysSettings.svelte` already used to gate integration keys) - the role on the category doc is `User`,
  so the Owner gate for Outgoing is purely client-side in this component, not enforced by the category role.
- `WebhookIncomingSection.svelte` deleted; its packet-building code (buildExample/PLACEHOLDER_*/endpoint
  lines) moved verbatim into `ConstructIncomingWebhookPopup.svelte`, decoupled from key creation entirely
  (that dialog never creates or shows a key - only picks one operation via `RadioGroup` instead of the old
  multi-checkbox `Set<ApiKeyOperation>`).
- New `ApiKeyRow.svelte`: per-key `Expandable` row. Gotcha: `<svelte:fragment slot="...">` must be a direct
  child of the component tag - wrapping it in `{#if}` is a svelte-check **error**, not just ugly; put the
  `{#if}` *inside* the fragment instead.

## Section layout (follows the space type editor)
- `IntegrationsSettings.svelte` is a frame only: `Header` + `Breadcrumbs`, left anchor-link column
  (`NavItem type="type-anchor-link"`) and a `Scroller` stacking `hulyTableAttr-container` sections -
  copied from `spaceTypes/editor/SpaceTypeEditor.svelte`.
- Sections: `ApiKeysSection.svelte` (rendered twice, `personal` prop), `WebhookEndpointsSection.svelte`.
  Header is `hulyTableAttr-header` with a primary `ButtonIcon IconAdd`; rows are
  `hulyTableAttr-content__row`. The request constructor sits in the personal section header, the only
  one every member sees.
- Endpoint editing moved out of a modal into `WebhookEndpointEditor.svelte`, a drill-in page addressed by
  `loc.path[5]` (path[3]='setting', path[4]='integrations'), like the space-type sub-editors. Saving is
  per field on change - no page-level Save. `WebhookEndpointPopup.svelte` deleted; creation kept as a
  small modal (`CreateWebhookEndpoint.svelte`: url + events), which then navigates into the editor.
- Strings `WebhookManage`, `WebhookSaveChanges`, `WebhookLastDelivery`, `WebhookNeverDelivered` deleted
  with the modal (12 lang files).

## incoming permission (ApiKeySecret.incoming)
- New independent gate, unrelated to `ops`/`unrestricted`. `verifyApiKey` computes
  `incoming: secret.incoming === true` into `ApiKeyCheck` (non-optional there, unlike the optional storage field).
- `pod-webhook`'s `handleIngest` checks it right after `check === null` (auth-level, before body/action
  parsing) and returns the *exact same* 401 `unauthorized` response as an unknown key - the caller must not
  be able to distinguish "wrong key" from "valid key, ingest not permitted". Only the internal `logCall`
  result string differs (`incoming_disabled` vs `unauthorized`).
- Test gotcha: `server.test.ts`'s shared `baseCheck` needed `incoming: true` added, otherwise every existing
  auth/ops/rate-limit test that reused it would start failing at the new gate.

## Tooling gotcha hit this session
- `rush fast-build:lint --to <pkg>` "(cached)" can appear misleadingly right after editing a file if you
  run the same `--to` twice in a row (second run legitimately cache-hits the first run's fresh result) -
  don't mistake that for a stale/stuck cache. To sanity-check a suspicious cache hit, run `npx eslint src
  --ext .ts,.svelte` (or `npx svelte-check`) directly in the package dir for an uncached, immediate answer.
- The "~95 pre-existing warnings" the task described are plain ESLint warnings (`fast-build:lint`), not
  svelte-check output - the two tools are separate phases (`fast-build:lint` = compile+validate+ESLint;
  `fast-build:svelte-check` is a different command) and report different counts/files.
