//
// Copyright © 2020 Anticrm Platform Contributors.
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
//

import { Analytics } from '@hcengineering/analytics'
import '@hcengineering/platform-rig/profiles/ui/svelte'
import { derived, writable } from 'svelte/store'
import { ThemeVariant, type ThemeVariantType, AccentColor, type AccentColorType } from './variants'

export { default as Theme } from './Theme.svelte'
export { default as InvertedTheme } from './InvertedTheme.svelte'
export { ThemeVariant, type ThemeVariantType, AccentColor, type AccentColorType } from './variants'
export { accentColorOptions, type AccentColorOption, getAccentColorName } from './accent'

/**
 * @public
 */
export const setDefaultLanguage = (language: string): void => {
  if (localStorage.getItem('lang') === null) {
    localStorage.setItem('lang', language)
  }
}

let forceAccent: AccentColorType | undefined
/**
 * @public
 */
export const setDefaultAccent = (accent: string): void => {
  if (localStorage.getItem('accent') === null) {
    localStorage.setItem('accent', accent)
  }
}

export const isForceAccentColor = (): boolean => {
  return forceAccent != null && (forceAccent as any) !== ''
}

export const setForceAccent = (value: AccentColorType): void => {
  if (!value.startsWith('accent-')) {
    forceAccent = ('accent-' + value) as AccentColorType
  }
  forceAccent = value
}

function getDefaultProps (prop: string, value: string): string {
  localStorage.setItem(prop, value)
  return value
}

/**
 * @public
 */
export const isSystemThemeDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches
/**
 * @public
 */
export const isThemeDark = (theme: string): boolean =>
  theme === 'theme-dark' || (theme === 'theme-system' && isSystemThemeDark())
/**
 * @public
 */
export const getCurrentTheme = (): string => localStorage.getItem('theme') ?? getDefaultProps('theme', 'theme-system')
/**
 * @public
 */
export const getCurrentFontSize = (): string =>
  localStorage.getItem('fontsize') ?? getDefaultProps('fontsize', 'normal-font')
/**
 * @public
 */
export const getCurrentLanguage = (): string => {
  const lang = localStorage.getItem('lang') ?? getDefaultProps('lang', 'en')
  Analytics.setTag('language', lang)
  return lang
}
/**
 * @public
 */
export const getCurrentEmoji = (): string => localStorage.getItem('emoji') ?? getDefaultProps('emoji', 'emoji-system')
/**
 * @public
 */
export const getCurrentAccentColor = (): AccentColorType =>
  (forceAccent ?? localStorage.getItem('accent') ?? getDefaultProps('accent', AccentColor.Intabia)) as AccentColorType

/**
 * @public
 *
 * Build composite accent class name of form `accent-{theme}-{accent}`.
 * `theme` is expected to be the full theme class (e.g. 'theme-light' or 'theme-dark')
 * and `accent` is the accent class (e.g. 'accent-huly'). Returns an empty string
 * when `accent` is null/undefined or an empty string.
 */
export const getCompositeAccentClass = (theme: string, accent?: string): string => {
  if (accent === undefined || accent === null || accent === '') return ''
  const themeShort = isThemeDark(theme) ? 'dark' : 'light'
  const accentShort = accent.replace(/^accent-/, '')
  return `accent-${themeShort}-${accentShort}`
}

export class ThemeOptions {
  readonly variant: ThemeVariantType
  constructor (
    readonly fontSize: number,
    readonly dark: boolean,
    readonly language: string,
    readonly emoji: string,
    readonly accent: AccentColorType
  ) {
    this.variant = dark ? ThemeVariant.Dark : ThemeVariant.Light
  }
}
export const themeStore = writable<ThemeOptions>()

export function initThemeStore (): void {
  themeStore.set(
    new ThemeOptions(
      getCurrentFontSize() === 'normal-font' ? 16 : 14,
      isThemeDark(getCurrentTheme()),
      getCurrentLanguage(),
      getCurrentEmoji(),
      getCurrentAccentColor()
    )
  )
}

export const languageStore = derived(themeStore, ($theme) => $theme?.language ?? '')
