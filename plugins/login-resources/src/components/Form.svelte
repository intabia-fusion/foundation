<!--
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021, 2022, 2023 Hardcore Engineering Inc.
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
  import { OK, Severity, Status, translate } from '@hcengineering/platform'
  import { deviceOptionsStore as deviceInfo, themeStore } from '@hcengineering/ui'
  import Label from './internal/Label.svelte'
  import StylishEdit from './internal/StylishEdit.svelte'
  import FormButton from './internal/FormButton.svelte'
  import StatusControl from './StatusControl.svelte'

  import { onMount } from 'svelte'
  import { BottomAction, loginTheme } from '..'
  import { makeSequential } from '../mutex'
  import type { Field } from '../types'
  import login from '../plugin'
  import BottomActionComponent from './BottomAction.svelte'
  import Providers from './Providers.svelte'
  import Tabs from './Tabs.svelte'

  interface Action {
    i18n: IntlString
    func: () => Promise<void>
  }

  export let caption: IntlString | undefined
  export let status: Status
  export let fields: Field[]
  export let action: Action
  export let secondaryButtonLabel: IntlString | undefined = undefined
  export let secondaryButtonAction: (() => void) | undefined = undefined
  export let bottomActions: BottomAction[] = []
  export let object: any
  export let ignoreInitialValidation: boolean = false
  export let withProviders: boolean = false
  export let subtitle: string | undefined = undefined
  export let signUpDisabled = false
  export let isLoading: boolean = false
  export let proceedDisabled: boolean = false

  const validate = makeSequential(async function validateAsync (language: string): Promise<boolean> {
    if (ignoreInitialValidation || isLoading) return true

    for (const field of fields) {
      const v = object[field.name]
      const f = field
      if (!f.optional && (!v || v.trim() === '')) {
        status = new Status(Severity.INFO, login.status.RequiredField, {
          field: await translate(field.i18n, {}, language)
        })
        return false
      }
      if (f.id !== undefined) {
        const sameFields = fields.filter((f) => f.id === field.id)
        for (const field of sameFields) {
          const v = object[field.name]
          if (v !== object[f.name]) {
            status = new Status(Severity.INFO, login.status.FieldsDoNotMatch, {
              field: await translate(field.i18n, {}, language),
              field2: await translate(f.i18n, {}, language)
            })
            return false
          }
        }
      }
      if (f.rules !== undefined) {
        for (const rule of f.rules) {
          const isValid =
            typeof rule.rule === 'function' ? rule.rule(v) !== rule.notMatch : rule.rule.test(v) !== rule.notMatch

          if (!isValid) {
            status = new Status(Severity.INFO, rule.ruleDescr, rule.ruleDescrParams ?? {})
            return false
          }
        }
      }
    }
    status = OK
    return true
  })

  export function invalidate (): void {
    void validate($themeStore.language)
  }

  $: if ($themeStore.language != null && $themeStore.language !== '') {
    void validate($themeStore.language)
  }

  let inAction = false

  function performAction (action: Action): void {
    if (inAction) return

    for (const field of fields) {
      trim(field.name)
    }
    inAction = true
    void action.func().finally(() => {
      inAction = false
    })
  }
  onMount(() => (ignoreInitialValidation = false))

  function trim (field: string): void {
    object[field] = (object[field] as string).trim()
  }

  /**
   * Функция для форматирования телефона к виду +7-XXX-XXX-XX-XX
   */
  function formatPhone (value: string): string {
    if (value == null || value === '' || value === '+7' || value === '+7-') {
      return ''
    }

    const digits = value.replace(/\D/g, '')

    if (digits.length === 0) {
      return ''
    }

    const clean = digits.replace(/^[87]/, '')
    let formatted = '+7'

    if (clean.length > 0) {
      formatted += `-${clean.slice(0, 3)}`
    }

    if (clean.length > 3) {
      formatted += `-${clean.slice(3, 6)}`
    }

    if (clean.length > 6) {
      formatted += `-${clean.slice(6, 8)}`
    }

    if (clean.length > 8) {
      formatted += `-${clean.slice(8, 10)}`
    }

    return formatted
  }

  let loginState: 'login' | 'signup' | 'none' = 'none'
  $: loginState = caption === login.string.LogIn ? 'login' : caption === login.string.SignUp ? 'signup' : 'none'
</script>

<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
<form
  class="container"
  style:padding={$deviceInfo.docWidth <= 480 ? '1.25rem 1rem' : '2rem 2rem'}
  on:keydown={(evt) => {
    if (evt.key === 'Enter') {
      evt.preventDefault()
      evt.stopPropagation()
      if (!inAction) {
        void validate($themeStore.language).then((res) => {
          if (res) {
            performAction(action)
          }
        })
      }
    }
  }}
>
  {#if loginState !== 'none'}
    {#if $loginTheme.showLoginTitle}
      <div class="main-heading">
        <Label className="login-label main-heading__label" variant="heading" label={login.string.SignToProceed} />
      </div>
    {/if}
    <Tabs {loginState} {signUpDisabled} />
  {:else}
    {#if subtitle !== undefined}
      <div class="fs-title">
        {subtitle}
      </div>
    {/if}
    <div class="flex-row-center">
      {#if caption !== undefined}
        <div class="title"><Label label={caption} /></div>
      {/if}
      <slot name="region-selector" />
    </div>
  {/if}
  <div class="form">
    {#each fields as field (field.name)}
      <div class={field.short !== undefined && !($deviceInfo.docWidth <= 600) ? 'form-col' : 'form-row'}>
        <StylishEdit
          label={field.i18n}
          name={field.idOverride ?? field.id}
          password={field.password}
          inputmode={field.inputmode}
          disabled={inAction || field.disabled}
          bind:value={object[field.name]}
          on:input={() => {
            if (field.name === 'phone') {
              object[field.name] = formatPhone(object[field.name] ?? '')
            }

            void validate($themeStore.language)
          }}
          on:blur={() => {
            trim(field.name)
          }}
        />
      </div>
    {/each}
    <slot name="after-fields" />
    <div class="status">
      <StatusControl {status} />
    </div>

    <div class="form-row send">
      <FormButton
        label={action.i18n}
        kind={'contrast'}
        shape={'round'}
        size={'x-large'}
        width="100%"
        loading={inAction}
        disabled={proceedDisabled || (status.severity !== Severity.OK && status.severity !== Severity.ERROR)}
        on:click={(e) => {
          e.preventDefault()
          if (!inAction) {
            void validate($themeStore.language).then((res) => {
              if (res) {
                performAction(action)
              }
            })
          }
        }}
      />
    </div>
    {#if secondaryButtonLabel !== undefined && secondaryButtonAction}
      <slot name="before-secondary" />
      <div class="form-row">
        <FormButton
          label={secondaryButtonLabel}
          width="100%"
          on:click={(e) => {
            e.preventDefault()
            secondaryButtonAction?.()
          }}
        />
      </div>
    {/if}
  </div>
  {#if withProviders}
    <Providers />
  {/if}
  {#if bottomActions.length}
    <div class="footer">
      {#each bottomActions as action}
        <BottomActionComponent {action} />
      {/each}
    </div>
  {/if}
</form>

<style lang="scss">
  .container {
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-width: 100%;

    .fs-title {
      color: var(--login-content-color, var(--theme-content-color));
    }

    .title {
      font-weight: var(--login-title-font-weight, 500);
      font-size: var(--login-title-font-size, 1.25rem);
      color: var(--login-caption-color, var(--theme-caption-color));
    }

    /* Main heading (title above tabs/signup/login) */
    .main-heading {
      display: flex;
      justify-content: center;
      align-items: center;
      font-size: 28px;
      font-style: Bold;
    }

    .login-label.main-heading__label {
      display: flex;
      justify-content: center;
      align-items: flex-end;
      padding: 0 0 16px;
      max-width: 412px;
      width: 100%;
      min-height: 36px;
      font-family: 'Open Sans', sans-serif;
      font-style: normal;
      font-weight: var(--login-main-heading-font-weight, 700);
      font-size: var(--login-main-heading-font-size, 28px);
      line-height: var(--login-main-heading-line-height, 38px);
      letter-spacing: var(--login-main-heading-letter-spacing, -0.005em);
      text-align: center;
      color: var(--login-heading-color, #000061) !important;
    }
    .status {
      padding-top: 1rem;
      grid-column-start: 1;
      grid-column-end: 3;
    }

    .form {
      background: var(--login-form-bg, transparent);
      padding: var(--login-form-padding, 0);
      border-radius: var(--login-form-border-radius, 0);
      box-shadow: var(--login-form-box-shadow, none);
      color: var(--login-content-color, var(--theme-content-color));
      display: grid;
      column-gap: var(--login-form-column-gap, 0.75rem);
      row-gap: var(--login-form-row-gap, 1.5rem);
      margin-top: var(--login-form-margin-top, 1.5rem);
      grid-template-columns: var(--login-form-grid-template, 1fr 1fr);

      .form-row {
        grid-column-start: 1;
        grid-column-end: 3;
      }

      .hint {
        margin-top: 1rem;
        font-size: 0.8rem;
        color: var(--login-label-color, var(--login-content-color, var(--theme-content-color)));
      }

      .send {
        margin-top: 0rem;
      }
    }
    .grow-separator {
      flex-grow: 1;
    }
    .footer {
      margin-top: 1.75rem;
      font-size: 0.8rem;
      text-align: center;
      color: var(--login-label-color, var(--login-content-color, var(--theme-content-color)));
      span {
        color: var(--login-darker-color, var(--theme-darker-color));
      }
      a {
        font-weight: 500;
        text-decoration: underline;
        color: var(--login-label-color, var(--login-content-color, var(--theme-content-color)));
      }
    }
  }

  @media (max-width: 600px) {
    .container {
      // The page scrolls as a whole; clipping here would hide tall forms.
      overflow: visible;

      .main-heading {
        font-size: 1.5rem;
      }

      /* Grid stays 2-column: slotted content elsewhere hardcodes a 1/3 span. */
      .form {
        row-gap: 1rem;
        margin-top: 1rem;
      }

      .status {
        padding-top: 0.5rem;
      }

      .footer {
        margin-top: 1.25rem;
      }
    }
  }
</style>
