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
  /**
   * LoginCodeInput
   *
   * Inlined copy of `CodeInput` tuned for the login theme scope. This component
   * reads `--login-*` tokens directly so login themes can fully control visuals
   * (background, focus overlay, caret, placeholder, etc.).
   *
   * API mirrors the original `CodeInput`: `value`, `id`, `name`, `size`, `kind`
   * and forwards any additional attributes to the underlying `<input>` via
   * `$$restProps`.
   */
  export let value: string | undefined = undefined
  export let id: string | undefined = undefined
  export let name: string | undefined = undefined
  export let size: 'small' | 'medium' = 'small'
  export let kind: 'primary' | 'secondary' = 'primary'
</script>

<div class="container {kind}">
  <input
    class={size}
    type="text"
    {id}
    {name}
    bind:value
    on:blur
    on:change
    on:keyup
    on:input
    inputmode="numeric"
    autocomplete="off"
    placeholder=""
    spellcheck="false"
    autocapitalize="on"
    {...$$restProps}
  />
</div>

<style lang="scss">
  .container {
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 0;
    min-width: 0;
    /* Prefer login-scoped input background (Intabia = pale lilac; Huly = translucent) */
    background-color: var(--login-input-bg, var(--theme-button-default));
    border: 1px solid var(--theme-button-border);
    border-radius: 0.75rem;

    &.primary {
      /* primary kind uses content color */
      caret-color: var(--login-input-text-color, var(--theme-content-color));
    }

    &.secondary {
      /* secondary kind uses caret token */
      caret-color: var(--login-caret-color, var(--theme-caret-color));
    }

    &:focus-within {
      /* On focus use the login-scoped focus background if provided
         (Huly sets a subtle overlay; Intabia keeps it equal to the input bg). */
      background-color: var(--login-input-focus-bg, var(--login-input-bg, var(--theme-button-focused))) !important;
      border-color: var(--login-list-divider-color, var(--theme-list-divider-color));
    }

    input {
      text-align: center;
      margin: 0;
      padding: 0;
      background-color: transparent;
      border: none;
      border-radius: 0.75rem;

      /* Ensure text + caret colors come from login tokens so Intabia/Huly control appearance */
      color: var(--login-input-text-color, var(--theme-content-color));
      caret-color: var(--login-caret-color, var(--login-input-text-color, var(--theme-content-color)));

      &.small {
        width: 1.5rem;
        height: 2rem;
        font-size: 1rem;
      }

      &.medium {
        width: 60px;
        height: 78px;
        font-size: 2rem;
        /* Width comes from the flex row on narrow screens; see OtpForm. */
        max-width: 100%;
        min-width: 0;
      }
    }
  }
</style>
