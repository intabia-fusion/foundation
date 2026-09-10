<!--
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License, this software is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import type { IntlString } from '@hcengineering/platform'
  import { translateCB } from '@hcengineering/platform'
  import { themeStore } from '@hcengineering/theme'

  // Basic button for login forms. Keep API small and predictable so styles
  // can be controlled locally by the login theme.
  export let label: IntlString | undefined = undefined
  export let params: Record<string, any> = {}
  export let kind: 'default' | 'contrast' | 'primary' | string = 'default'
  export let shape: 'round' | 'square' | string = 'round'
  export let size: 'small' | 'default' | 'large' | 'x-large' | string = 'default'
  export let width: string | undefined = undefined
  export let loading: boolean = false
  export let disabled: boolean = false

  let _labelValue: string | undefined

  // Reactively translate when label/params/language changes.
  $: if (label !== undefined) {
    translateCB(label, params ?? {}, $themeStore.language, (r) => {
      _labelValue = r
    })
  } else {
    _labelValue = label
  }

  // Allow consumers to set type if needed
  export let type: 'button' | 'submit' | 'reset' = 'button'

  // Provide a small helper class string
  $: classes = `form-button kind-${kind} shape-${shape} size-${size}`

  function localClickGuard (e: MouseEvent): void {
    if (disabled || loading) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
</script>

<button
  class={classes}
  style:width
  {type}
  disabled={disabled || loading}
  aria-busy={loading}
  {...$$restProps}
  on:click={localClickGuard}
  on:click
>
  {#if loading}
    <span class="loader" aria-hidden="true"></span>
  {/if}
  {#if label}
    <span class="button-label">{_labelValue ?? label}</span>
  {:else}
    <slot />
  {/if}
</button>

<style lang="scss">
  /* Local button used only by forms in this plugin.
     Visuals derive from theme variables (accent tokens) so themes only
     need to change colors/backgrounds and not layout. */

  .form-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    min-height: 2.75rem;
    padding: 0.65rem 1rem;
    border-radius: 0.5rem;
    border: 0;
    cursor: pointer;
    font-weight: var(--login-primary-button-font-weight, var(--primary-button-font-weight, 600));
    font-size: 0.95rem;
    line-height: 1;
    transition:
      background-color 0.12s ease,
      transform 0.06s ease,
      opacity 0.12s ease;
    box-sizing: border-box;
    width: auto;

    &:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      pointer-events: none;
    }

    &:focus {
      outline: 0;
      box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.06);
    }
  }

  .size-x-large {
    min-height: 3.5rem;
    padding: 0 1.5rem;
    font-size: 1rem;
  }

  /* Variant: contrast/primary use login-prefixed tokens first (fallback to theme tokens).
     This ensures localized components read login- prefixed variables while remaining
     backwards compatible. */
  .kind-contrast {
    /* Size & geometry */
    border-radius: 0.5rem;
    padding: 0 1.5rem;
    height: 3.5rem;
    font-size: 1rem;
    font-weight: var(--login-primary-button-font-weight, var(--primary-button-font-weight, 500));

    /* Use explicit contrast tokens (enabled = white bg / black text) */
    background: var(--login-button-contrast-enabled, var(--theme-button-contrast-enabled, rgb(255, 255, 255)));
    color: var(--login-button-contrast-color, var(--theme-button-contrast-color, rgb(0, 0, 0)));

    &:hover {
      background: var(--login-button-contrast-hovered, var(--theme-button-contrast-hovered, #ffffff));
    }
    &:active {
      background: var(--login-button-contrast-pressed, var(--theme-button-contrast-pressed, rgba(255, 255, 255, 0.6)));
      transform: translateY(1px);
    }

    /* Visible focus ring for keyboard users (use theme token) */
    &:focus-visible {
      outline: 0;
      box-shadow: 0 0 0 4px var(--login-primary-button-focus-ring, rgba(0, 0, 0, 0.08));
      border-color: var(--login-primary-button-focused, var(--primary-button-focused, rgba(0, 0, 0, 0.06)));
    }

    /* Disabled appearance (explicit contrast disabled tokens) */
    &:disabled {
      background: var(
        --login-button-contrast-disabled,
        var(--theme-button-contrast-disabled, rgba(255, 255, 255, 0.6))
      );
      color: var(
        --login-button-contrast-disabled-color,
        var(--theme-button-contrast-disabled-color, rgba(0, 0, 0, 0.5))
      );
      cursor: not-allowed;
      opacity: 1; /* override base opacity so disabled color is predictable */
      box-shadow: none;
      border-color: var(--login-button-contrast-border, var(--theme-button-contrast-border, rgba(0, 0, 0, 0.06)));
    }
  }
  .kind-default {
    background: var(--login-button-default, var(--theme-button-default, #ffffff));
    color: var(--login-content-color, var(--theme-content-color, #111111));
    border: 1px solid var(--login-button-border, var(--theme-button-border, rgba(0, 0, 0, 0.06)));

    &:hover {
      background: var(--login-button-hovered, var(--theme-button-hovered, #f9fafb));
    }
    &:active {
      background: var(--login-button-pressed, var(--theme-button-pressed, #f3f4f6));
      transform: translateY(1px);
    }
  }

  /* Ghost: minimal, transparent by default and shows a subtle hover background.
     Mirrors the global Button.ghost semantics while keeping login-scoped tokens. */
  .kind-ghost {
    background: transparent;
    color: var(--login-content-color, var(--theme-content-color, #111111));
    border: 0;

    &:hover {
      background: var(--login-button-hovered, var(--theme-button-hovered, #f9fafb));
    }
    &:active {
      background: var(--login-button-pressed, var(--theme-button-pressed, #f3f4f6));
      transform: translateY(1px);
    }

    &:focus-visible {
      outline: 0;
      box-shadow: 0 0 0 4px var(--login-primary-button-focus-ring, rgba(0, 0, 0, 0.08));
      border-color: var(--login-primary-button-focused, var(--primary-button-focused, rgba(0, 0, 0, 0.06)));
    }

    &:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      pointer-events: none;
    }

    .btn-icon {
      color: var(--login-content-color, var(--theme-content-color));
    }
  }

  /* small loader */
  .loader {
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    border: 2px solid var(--login-dark-color);
    border-top-color: var(--login-button-contrast-disabled-color);
    animation: spin 0.9s linear infinite;
    display: inline-block;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Shape helpers */
  .shape-round {
    border-radius: 0.5rem;
  }
  .shape-square {
    border-radius: 0.125rem;
  }

  /* Button label should inherit the button color (don't reuse `.login-label` inside buttons). */
  .button-label {
    color: inherit;
    display: inline;
    line-height: inherit;
  }

  .kind-black {
    /* Provider-specific black variant. Use login-scoped tokens so only
       the Intabia theme needs to define colors (Huly and other themes
       will fall back to their defaults). */
    border-radius: 0.5rem;
    padding: 0 1.5rem;
    height: 3.5rem;
    font-size: 1rem;
    font-weight: 400;

    /* Use Intabia provider tokens if present, otherwise fall back to
       existing login/theme button tokens. */
    background: var(
      --button-black-BackgroundColor,
      var(--login-button-contrast-enabled, var(--theme-button-contrast-enabled, #07040f))
    );
    color: var(
      --button-black-LabelColor,
      var(--login-button-contrast-color, var(--theme-button-contrast-color, #ffffff))
    );
    border: 1px solid var(--button-black-border, transparent);

    /* Ensure icons inside provider buttons use the provider icon color when available */
    .btn-icon {
      color: var(--button-black-IconColor, var(--theme-content-color));
    }

    /* Ensure label inside provider buttons uses the provider label color so
       the text is readable (white). Providers can opt-in by passing
       labelClass="button-label" to their Label instance. */
    .button-label {
      color: var(--button-black-LabelColor, var(--login-button-text-color, var(--theme-content-color))) !important;
    }

    &:hover {
      background: var(
        --button-black-hover-BackgroundColor,
        var(--login-button-contrast-hovered, var(--theme-button-contrast-hovered, #0b0813))
      );
    }
    &:active {
      background: var(
        --button-black-active-BackgroundColor,
        var(--login-button-contrast-pressed, var(--theme-button-contrast-pressed, #05030b))
      );
      transform: translateY(1px);
    }

    &:focus-visible {
      outline: 0;
      box-shadow: 0 0 0 4px var(--login-primary-button-focus-ring, rgba(0, 0, 0, 0.08));
      border-color: var(--login-primary-button-focused, var(--primary-button-focused, rgba(0, 0, 0, 0.06)));
    }

    &:disabled {
      background: var(
        --login-button-contrast-disabled,
        var(--theme-button-contrast-disabled, rgba(255, 255, 255, 0.6))
      );
      color: var(
        --login-button-contrast-disabled-color,
        var(--theme-button-contrast-disabled-color, rgba(0, 0, 0, 0.5))
      );
      cursor: not-allowed;
      opacity: 1;
      box-shadow: none;
      border-color: var(--login-button-contrast-border, var(--theme-button-contrast-border, rgba(0, 0, 0, 0.06)));
    }
  }

  /* Intabia-specific overrides were moved to the theme stylesheet
     (plugins/login-resources/src/components/themes/intabia.scss). Keep
     component styles focused and localized; theme-level visual mappings
     belong in the theme file. */
</style>
