<!--
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import type { IntlString } from '@hcengineering/platform'
  import Label from './Label.svelte'

  export let label: IntlString | undefined = undefined
  export let width: string | undefined = undefined
  export let value: string | undefined = undefined
  export let error: string | undefined = undefined
  export let password: boolean | undefined = undefined
  export let id: string | undefined = undefined
  export let name: string | undefined = undefined
  export let disabled: boolean = false
  export let inputmode: 'email' | 'tel' | undefined = undefined
</script>

<div class="editbox{error ? ' error' : ''}" style={width ? 'width: ' + width : ''}>
  {#if password}
    <input
      type="password"
      class:nolabel={!label}
      {id}
      {name}
      bind:value
      on:blur
      on:change
      on:keyup
      on:input
      autocomplete="off"
      placeholder=" "
      spellcheck="false"
      autocapitalize="off"
      {disabled}
    />
  {:else if inputmode === 'email'}
    <input
      type="email"
      inputmode="email"
      class:nolabel={!label}
      {id}
      {name}
      bind:value
      on:blur
      on:change
      on:keyup
      on:input
      autocomplete="off"
      placeholder=" "
      spellcheck="false"
      autocapitalize="off"
      {disabled}
    />
  {:else if inputmode === 'tel'}
    <input
      type="tel"
      inputmode="tel"
      class:nolabel={!label}
      {id}
      {name}
      bind:value
      on:blur
      on:change
      on:keyup
      on:input
      autocomplete="off"
      placeholder=" "
      spellcheck="false"
      autocapitalize="off"
      {disabled}
    />
  {:else}
    <input
      type="text"
      class:nolabel={!label}
      {id}
      {name}
      bind:value
      on:blur
      on:change
      on:keyup
      on:input
      autocomplete="off"
      placeholder=" "
      spellcheck="false"
      autocapitalize="off"
      {disabled}
    />
  {/if}
  {#if label}
    <div class="label"><Label {label} /></div>
  {/if}
</div>

<style lang="scss">
  /* Localized input control for login pages.
     Uses --login-* variables so the login theme can fully control colors
     (themes map login-* variables to actual colors). Fallbacks to existing
     theme variables are provided for backwards compatibility. */

  .editbox {
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 0;
    min-width: 3rem;
    height: 3.25rem;
    /* Prefer login-scoped input background (Intabia uses a pale lilac) */
    background-color: var(--login-input-bg, var(--theme-button-default));
    border: 1px solid var(--login-button-border, var(--theme-button-border));
    border-radius: 0.75rem;
    /* Prefer login-scoped caret so login themes can ensure visibility */
    caret-color: var(--login-caret-color, var(--theme-caret-color));

    &:focus-within {
      /* Allow themes to control subtle input focus background changes via
         --login-input-focus-bg (Huly sets a subtle overlay; Intabia maps it
         to the same value as input bg so there is no change). */
      background-color: var(--login-input-focus-bg, var(--login-input-bg, var(--theme-button-default))) !important;
      border-color: var(--login-list-divider-color, var(--theme-list-divider-color));
    }

    input {
      height: 3.25rem;
      margin: 0;
      padding: 0.875rem 1.25rem 0px;
      background-color: transparent;
      border: none;
      border-radius: 0.75rem;
      /* Explicitly set content color so themes (like Intabia) keep the text
         color consistent even when focus/background changes. */
      color: var(--login-input-text-color, var(--login-content-color, var(--theme-content-color)));
      /* make the caret match the input text color (ensures visibility in Intabia) */
      caret-color: var(
        --login-caret-color,
        var(--login-input-text-color, var(--login-content-color, var(--theme-content-color)))
      );

      &::placeholder {
        color: var(--login-placeholder-color, var(--login-caption-color, var(--theme-caption-color)));
        opacity: 1;
      }

      &:disabled {
        background-color: var(--theme-button-pressed);
      }
    }

    .nolabel {
      padding-top: 0;
    }

    .label {
      position: absolute;
      top: 1rem;
      left: 1.25rem;
      font-size: 0.75rem;
      color: var(--login-caption-color, var(--theme-caption-color));
      opacity: 0.8;
      transition: top 200ms;
      pointer-events: none;
      user-select: none;
    }
    input:focus + .label,
    input:not(:placeholder-shown) + .label {
      top: 0.5rem;
    }
  }
  .error {
    border: 1px solid var(--system-error-60-color);
    &:focus-within {
      border-color: var(--system-error-color);
    }
  }

  /* Autofill fallback — ensure browser-suggested values use the login theme's colors
     when a per-theme override is not available. */
  input:-webkit-autofill,
  input:-webkit-autofill:hover,
  input:-webkit-autofill:focus,
  textarea:-webkit-autofill,
  textarea:-webkit-autofill:hover,
  textarea:-webkit-autofill:focus,
  select:-webkit-autofill,
  select:-webkit-autofill:hover,
  select:-webkit-autofill:focus {
    -webkit-text-fill-color: var(
      --login-input-text-color,
      var(--login-content-color, var(--theme-content-color))
    ) !important;
    -webkit-box-shadow: 0 0 0 1000px var(--login-input-bg, var(--login-button-default, var(--theme-button-default)))
      inset !important;
    box-shadow: 0 0 0 1000px var(--login-input-bg, var(--login-button-default, var(--theme-button-default))) inset !important;
    background-color: transparent !important;
    transition: background-color 5000s ease-in-out 0s;
  }
</style>
