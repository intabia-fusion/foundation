<!--
// Copyright © 2020, 2021 Anticrm Platform Contributors.
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
  import { Analytics } from '@hcengineering/analytics'
  import platform, { loadPluginStrings, setMetadata } from '@hcengineering/platform'
  import { onMount, setContext } from 'svelte'
  import { writable } from 'svelte/store'
  import { ThemeVariant, type AccentColorType } from './variants'
  import {
    ThemeOptions,
    getCurrentFontSize,
    getCurrentLanguage,
    getCurrentTheme,
    isSystemThemeDark,
    isThemeDark,
    themeStore as themeOptions,
    getCurrentEmoji,
    getCurrentAccentColor
  } from './'

  const currentTheme = writable<string>(getCurrentTheme())
  const currentFontSize = writable<string>(getCurrentFontSize())
  const currentLanguage = writable<string>(getCurrentLanguage())
  const currentEmoji = writable<string>(getCurrentEmoji())
  const currentAccent = writable<string>(getCurrentAccentColor())

  const setOptions = (currentFont: string, theme: string, language: string, emoji: string, accent: string) => {
    themeOptions.set(
      new ThemeOptions(
        currentFont === 'normal-font' ? 16 : 14,
        isThemeDark(theme),
        language,
        emoji,
        accent as AccentColorType
      )
    )
  }

  const getRealTheme = (theme: string): string => (isThemeDark(theme) ? ThemeVariant.Dark : ThemeVariant.Light)

  // Helper: return short theme name ('light'|'dark') derived from full theme class
  const getThemeShort = (theme: string): string => getRealTheme(theme).replace(/^theme-/, '')

  // Helper: build composite accent class `accent-{themeShort}-{accentShort}`
  // e.g. theme='theme-light', accent='accent-huly' => 'accent-light-huly'
  const makeCompositeAccent = (theme: string, accent: string): string => {
    if (!accent) return ''
    const themeShort = getThemeShort(theme)
    const accentShort = accent.replace(/^accent-/, '')
    return `accent-${themeShort}-${accentShort}`
  }

  // Helper: centralised root class builder so all setters apply same classlist
  const buildRootClass = (theme: string, fontsize: string, emoji: string, accent: string) => {
    const realTheme = getRealTheme(theme)
    const composite = makeCompositeAccent(theme, accent)
    return `${realTheme} ${fontsize} ${emoji} ${accent} ${composite}`.trim()
  }
  const setRootColors = (theme: string, set = true) => {
    currentTheme.set(theme)
    if (set) {
      localStorage.setItem('theme', theme)
    }
    document.documentElement.setAttribute(
      'class',
      buildRootClass(theme, getCurrentFontSize(), getCurrentEmoji(), getCurrentAccentColor())
    )
    setOptions(getCurrentFontSize(), theme, getCurrentLanguage(), getCurrentEmoji(), getCurrentAccentColor())
  }
  const setRootFontSize = (fontsize: string, set = true) => {
    currentFontSize.set(fontsize)
    if (set) {
      localStorage.setItem('fontsize', fontsize)
    }
    document.documentElement.setAttribute(
      'class',
      buildRootClass(getCurrentTheme(), fontsize, getCurrentEmoji(), getCurrentAccentColor())
    )
    setOptions(fontsize, getCurrentTheme(), getCurrentLanguage(), getCurrentEmoji(), getCurrentAccentColor())
  }
  const setLanguage = async (language: string, set: boolean = true): Promise<void> => {
    currentLanguage.set(language)
    if (set) {
      localStorage.setItem('lang', language)
    }
    Analytics.setTag('language', language)
    setMetadata(platform.metadata.locale, $currentLanguage)
    await loadPluginStrings($currentLanguage, set)
    setOptions(getCurrentFontSize(), getCurrentTheme(), language, getCurrentEmoji(), getCurrentAccentColor())
  }
  const setEmoji = (emoji: string, set = true) => {
    currentEmoji.set(emoji)
    if (set) {
      localStorage.setItem('emoji', emoji)
    }
    document.documentElement.setAttribute(
      'class',
      buildRootClass(getCurrentTheme(), getCurrentFontSize(), getCurrentEmoji(), getCurrentAccentColor())
    )
    setOptions(getCurrentFontSize(), getCurrentTheme(), getCurrentLanguage(), emoji, getCurrentAccentColor())
  }
  const setAccent = (accent: string, set = true) => {
    currentAccent.set(accent)
    if (set) {
      localStorage.setItem('accent', accent)
    }
    document.documentElement.setAttribute(
      'class',
      buildRootClass(getCurrentTheme(), getCurrentFontSize(), getCurrentEmoji(), accent)
    )
    setOptions(getCurrentFontSize(), getCurrentTheme(), getCurrentLanguage(), getCurrentEmoji(), accent)
  }

  setContext('theme', {
    currentTheme,
    setTheme: setRootColors
  })
  setContext('fontsize', {
    currentFontSize,
    setFontSize: setRootFontSize
  })
  setContext('lang', {
    currentLanguage,
    setLanguage
  })
  setContext('emoji', {
    currentEmoji,
    setEmoji
  })
  setContext('accent', {
    currentAccent,
    setAccent
  })

  let remove: any = null

  function checkSystemTheme (): void {
    const theme = $currentTheme
    if (remove !== null || theme !== 'theme-system') {
      remove()
      remove = null
    }

    const isDark = isSystemThemeDark()
    const media = matchMedia(`(prefers-color-scheme: ${isDark ? 'light' : 'dark'})`)
    setRootColors(theme)
    media.addEventListener('change', checkSystemTheme)
    remove = () => {
      media.removeEventListener('change', checkSystemTheme)
    }
  }

  $: if ($currentTheme === 'theme-system') {
    checkSystemTheme()
  }

  const setDocumentLanguage = (): void => {
    document.documentElement.lang = $currentLanguage
  }

  onMount(() => {
    setRootColors($currentTheme, false)
    setRootFontSize($currentFontSize, false)
    void setLanguage($currentLanguage, false)
    void loadPluginStrings($currentLanguage)
    setDocumentLanguage()
    setAccent($currentAccent, false)
  })
</script>

<slot />
