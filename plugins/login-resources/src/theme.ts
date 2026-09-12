/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

import type { AnySvelteComponent } from '@hcengineering/ui/src/types'
import { writable, derived, type Readable } from 'svelte/store'
import GradiantBack from './components/GradiantBack.svelte'
import LoginIcon from './components/icons/LoginIcon.svelte'
import IntabiaIcon from './components/icons/IntabiaIcon.svelte'

/**
 * Names of supported login themes.
 */
export type LoginThemeName = 'intabia' | 'huly'

/**
 * Theme for the login UI: `alignment` places the panel, `backgroundComponent` renders
 * behind it, `logoComponent` renders the top-left logo.
 */
export interface LoginTheme {
  name: LoginThemeName
  alignment: 'left' | 'center' | 'right'
  showTitle: boolean
  showLoginTitle: boolean
  backgroundComponent?: AnySvelteComponent
  logoComponent?: AnySvelteComponent
  // optional html accent class (corresponds to classes in _accent-colors.scss)
  accentClass?: string
}

/**
 * Built-in themes for login-resources.
 */
export const themes: Record<LoginThemeName, LoginTheme> = {
  intabia: {
    name: 'intabia',
    alignment: 'center',
    backgroundComponent: GradiantBack,
    logoComponent: IntabiaIcon,
    showTitle: false,
    showLoginTitle: true,
    accentClass: 'accent-intabia'
  },

  huly: {
    name: 'huly',
    alignment: 'center',
    backgroundComponent: undefined,
    logoComponent: LoginIcon,
    showTitle: true,
    showLoginTitle: false,
    accentClass: 'accent-huly'
  }
}

/**
 * Default theme name used on startup.
 */
export const DEFAULT_THEME_NAME: LoginThemeName = 'intabia'

/**
 * Writable store that holds current theme name.
 * Use `setLoginTheme()` to change theme at runtime.
 */
export const loginThemeName = writable<LoginThemeName>(DEFAULT_THEME_NAME)

/**
 * Readable store that resolves to the active theme object.
 * Components can subscribe to `$loginTheme` to get theme parameters.
 */
export const loginTheme: Readable<LoginTheme> = derived(loginThemeName, ($name) => {
  return themes[$name]
})

/**
 * Set the current login theme by name.
 * Throws on unknown theme name.
 */
export function setLoginTheme (name: LoginThemeName): void {
  if (!(name in themes)) {
    throw new Error(`Unknown login theme: ${String(name)}`)
  }
  loginThemeName.set(name)
}
