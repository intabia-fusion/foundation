<script lang="ts">
  import { getMetadata, translate } from '@hcengineering/platform'
  import { themeStore, desktopPlatform } from '@hcengineering/ui'
  import login from '../plugin'

  export let agreedPersonalData: boolean = false
  export let agreedRules: boolean = false

  let personalDatalabel = ''
  $: void translate(
    login.string.AgreedPersonalData,
    { link: getMetadata(login.metadata.PersonalDataUrl) },
    $themeStore.language
  ).then((res) => {
    personalDatalabel = res
  })

  let rulesLabel = ''
  $: void translate(
    login.string.AgreedRules,
    {
      linkLicense: getMetadata(login.metadata.LicenseUrl),
      linkUserAgreement: getMetadata(login.metadata.UserAgreementUrl),
      linkConfidential: getMetadata(login.metadata.ConfidentialUrl)
    },
    $themeStore.language
  ).then((res) => {
    rulesLabel = res
  })

  function handleLinkClick (event: MouseEvent): void {
    const target = event.target as HTMLElement
    const anchor = target.closest('a')
    if (anchor != null) {
      const href = anchor.getAttribute('href')
      if (href != null) {
        event.preventDefault()
        window.open(anchor.href, '_blank', desktopPlatform ? 'externalBrowser=yes' : '')
      }
    }
  }

  function handleLinkKeyDown (event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      const target = event.target as HTMLElement
      const anchor = target.closest('a')
      if (anchor != null) {
        const href = anchor.getAttribute('href')
        if (href != null) {
          event.preventDefault()
          window.open(anchor.href, '_blank', desktopPlatform ? 'externalBrowser=yes' : '')
        }
      }
    }
  }
</script>

<label class="check-label">
  <input type="checkbox" data-testid="checkbox-personal-data" bind:checked={agreedPersonalData} />
  <span class="consent-link" role="presentation" on:click={handleLinkClick} on:keydown={handleLinkKeyDown}>
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html personalDatalabel}
  </span>
</label>
<label class="check-label">
  <input type="checkbox" data-testid="checkbox-rules" bind:checked={agreedRules} />
  <span class="consent-link" role="presentation" on:click={handleLinkClick} on:keydown={handleLinkKeyDown}>
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html rulesLabel}
  </span>
</label>

<style lang="scss">
  .check-label {
    display: inline-flex;
    gap: 0.5rem;
    font-size: 0.95rem;
    color: var(--login-content-color, var(--theme-content-color));
    margin-bottom: 0.5rem;
  }

  /* Custom-styled checkbox so it's visible across themes (Intabia/Huly).
     Keep visuals simple and theme-aware via `--login-*` tokens (fallbacks to global tokens). */
  .check-label input[type='checkbox'] {
    -webkit-appearance: none;
    appearance: none;
    width: 1.125rem;
    height: 1.125rem;
    /* Thicker, more contrasting border to ensure visibility on light backgrounds */
    border: 2px solid var(--login-darker-color, var(--theme-darker-color, rgba(0, 0, 0, 0.2)));
    background: var(--login-button-default, var(--theme-button-default, #ffffff));
    border-radius: 0.2rem;
    display: inline-block;
    flex-shrink: 0;
    position: relative;
    box-sizing: border-box;
    vertical-align: middle;
    /* Provide native accent fallback so platform checkboxes remain visible when appearance can't be suppressed */
    accent-color: var(--login-primary-button-default, var(--primary-button-default));
  }

  .check-label input[type='checkbox']:focus {
    outline: none;
    box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.06);
  }

  .check-label input[type='checkbox']:checked {
    background: var(--login-primary-button-default, var(--primary-button-default, #cf13a2));
    border-color: var(--login-primary-button-default, var(--primary-button-default));
  }

  .check-label input[type='checkbox']:checked::after {
    content: '';
    position: absolute;
    left: 0.36rem;
    top: 0.06rem;
    width: 0.26rem;
    height: 0.6rem;
    border: solid var(--login-button-text-color, var(--primary-button-color, #ffffff));
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  @media (max-width: 600px) {
    .check-label {
      align-items: flex-start;
      font-size: 0.875rem;
      line-height: 1.35;
    }

    /* Larger hit area on touch screens without changing the visual box size. */
    .check-label input[type='checkbox'] {
      margin: 0.15rem 0;
      outline-offset: 0.5rem;
    }
  }
</style>
