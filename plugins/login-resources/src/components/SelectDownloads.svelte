<!--
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
-->
<script lang="ts">
  // Flat grid of download buttons; clicking opens the resolved URL in a new tab.
  // Labels come from `friendlyLabel`; rendered at `login/downloads` from LoginApp.

  import { onMount } from 'svelte'
  import { getEmbeddedLabel, getMetadata } from '@hcengineering/platform'
  import type { IntlString } from '@hcengineering/platform'
  import login from '@hcengineering/login'
  import { goTo } from '../utils'
  import { Scroller, Spinner, IconBack, deviceOptionsStore as deviceInfo } from '@hcengineering/ui'
  import { themeStore, AccentColor } from '@hcengineering/theme'
  import FormButton from './internal/FormButton.svelte'
  import Label from './internal/Label.svelte'
  import PlatformIcon from './internal/PlatformIcon.svelte'

  interface DownloadArtifact {
    filename: string
    url: string
    size?: number
    sha512?: string
    modified?: string
    arch?: string
    archLabel?: string
    variant?: string
  }

  interface Variant {
    manifest: string
    variant?: string
    version?: string
    releaseDate?: string
    artifacts: DownloadArtifact[]
    raw?: any
  }

  interface PlatformGroup {
    platform: string
    name: IntlString
    variants: Variant[]
  }

  // Metadata
  const updatesUrl = getMetadata(login.metadata.DesktopUpdatesUrl)

  // Reactive UI state
  let loading = false
  let error: string | null = null
  let platforms: PlatformGroup[] = []

  // Platform detection removed - not needed for the simplified downloads list

  function resolveUrl (artifactUrl: string): string {
    if (typeof updatesUrl !== 'string' || updatesUrl === '') return artifactUrl
    if (artifactUrl.startsWith('http://') || artifactUrl.startsWith('https://')) return artifactUrl
    const base = updatesUrl.endsWith('/') ? updatesUrl.slice(0, -1) : updatesUrl
    return artifactUrl.startsWith('/') ? `${base}${artifactUrl}` : `${base}/${artifactUrl}`
  }

  // Generate a compact, user-friendly label for an artifact, e.g. "macOS - Apple Silicon" or "Linux - x64.AppImage"
  function normalizeArchLabel (value: string): string {
    if (value.trim() === '') return ''
    let s = String(value).trim()
    // Use split to avoid numeric index checks in conditionals
    const dashParts = s
      .split('-')
      .map((p) => p.trim())
      .filter(Boolean)
    if (dashParts.length > 1) s = dashParts[dashParts.length - 1]
    const low = s.toLowerCase()

    if (low.includes('apple') || low.includes('silicon')) return 'Apple Silicon'
    if (low.includes('aarch')) return 'ARM64'
    if (low.includes('arm')) {
      if (low.includes('64')) return 'ARM64'
      return 'ARM'
    }
    if (low.includes('x64') || low.includes('x86_64') || low.includes('amd64')) return 'x64'
    if (low.includes('x86') || low.includes('i386') || low.includes('i686')) return 'x86'
    if (low.includes('intel')) return 'Intel'
    if (/^[a-z0-9]+$/.test(low)) return low.toUpperCase()

    return s
      .split(/\s+/)
      .map((w) => (w.length ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(' ')
  }

  function friendlyLabel (p: PlatformGroup, a: DownloadArtifact): string {
    const platformName = p.name ?? (p.platform === 'mac' ? 'macOS' : p.platform === 'linux' ? 'Linux' : 'Windows')
    const filename = String(a.filename ?? a.url ?? '')
    const base = filename.split('?')[0]
    const parts = base
      .split('.')
      .map((p) => p.trim())
      .filter(Boolean)
    const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
    const archVal = String(a.archLabel ?? a.arch ?? '')
    const arch = normalizeArchLabel(archVal)
    const fname = filename.toLowerCase()

    if (p.platform === 'mac') {
      if (arch !== '') return ext !== '' ? `${platformName} - ${arch}.${ext}` : `${platformName} - ${arch}`
      if (fname.includes('arm') || fname.includes('aarch')) {
        return ext !== '' ? `${platformName} - Apple Silicon.${ext}` : `${platformName} - Apple Silicon`
      }
      if (fname.includes('x86') || fname.includes('intel') || fname.includes('amd')) {
        return ext !== '' ? `${platformName} - Intel.${ext}` : `${platformName} - Intel`
      }
      return ext !== '' ? `${platformName} - ${ext}` : `${platformName} - ${base}`
    }

    if (p.platform === 'linux' || p.platform === 'windows') {
      if (arch !== '' && ext !== '') return `${platformName} - ${arch}.${ext}`
      if (arch !== '') return `${platformName} - ${arch}`
      if (ext !== '') return `${platformName} - ${ext}`
      return `${platformName} - ${base}`
    }

    return `${platformName} - ${base}`
  }

  // Fetching -------------------------------------------------------------

  async function fetchDownloads (): Promise<void> {
    error = null
    platforms = []
    loading = true

    if (updatesUrl == null || updatesUrl === '') {
      error = 'Update server not configured'
      loading = false
      return
    }

    try {
      const base = updatesUrl.replace(/\/$/, '')
      const url = `${base}/api/downloads`
      const res = await fetch(url, { method: 'GET' })
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      const json = await res.json()
      const list: PlatformGroup[] = (json?.platforms ?? []).map((p: any) => ({
        platform: p.platform,
        name: (p.name ?? (p.platform === 'mac' ? 'macOS' : p.platform === 'linux' ? 'Linux' : 'Windows')) as IntlString,
        variants: (p.variants ?? []).map((v: any) => ({
          manifest: v.manifest,
          variant: v.variant,
          version: v.version,
          releaseDate: v.releaseDate,
          artifacts: (v.artifacts ?? []).map((a: any) => ({
            filename: a.filename,
            url: a.url,
            size: a.size,
            sha512: a.sha512,
            modified: a.modified,
            arch: a.arch,
            archLabel: a.archLabel,
            variant: a.variant
          })),
          raw: v.raw
        }))
      }))
      platforms = list
    } catch (err: any) {
      error = err?.message ?? String(err)
      console.error('[SelectDownloads.fetchDownloads] fetch failed', err)
    } finally {
      loading = false
    }
  }

  function openDownload (url?: string): void {
    if (!url) return
    const u = resolveUrl(String(url))
    if (typeof window !== 'undefined') {
      window.open(u, '_blank', 'noopener,noreferrer')
    }
  }

  // Exposed helper to allow reloading from parent
  export function refresh (): void {
    void fetchDownloads()
  }

  // Back handler extracted so it can be reused and kept out of markup
  function handleBack (): void {
    // Prefer optional chaining and explicit checks for clarity and safety
    if (typeof window !== 'undefined' && (window.history?.length ?? 0) > 1) {
      try {
        // Avoid sending the user back to an external site — prefer app navigation in that case
        const ref = document.referrer ?? ''
        if (ref !== '') {
          try {
            if (new URL(ref).origin !== window.location.origin) {
              goTo('login')
              return
            }
          } catch (e) {
            // Ignore URL parse errors and continue to history.back fallback
          }
        }

        const prevHref = window.location.href
        window.history.back()
        // If the browser didn't actually navigate after a short delay, fall back to the app route
        setTimeout(() => {
          if (window.location.href === prevHref) goTo('login')
        }, 400)
        return
      } catch (err) {
        console.error('[SelectDownloads.back] history.back failed', err)
      }
    }
    goTo('login')
  }

  // Helpers --------------------------------------------------------------
  // Detect host platform and architecture so we can highlight the most appropriate artifact
  let detectedPlatform: 'mac' | 'linux' | 'windows' | 'unknown' = 'unknown'
  let detectedArch: 'arm64' | 'x64' | undefined = undefined

  function isAppleSilicon (): boolean {
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl')
      const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info') as any | null
      const renderer = debugInfo && gl ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null
      return typeof renderer === 'string' && renderer.includes('Apple')
    } catch {
      return false
    }
  }

  function detectPlatformAndArch (): void {
    if (typeof navigator === 'undefined') {
      detectedPlatform = 'unknown'
      detectedArch = undefined
      return
    }

    const platformHint = (
      (navigator as any).userAgentData?.platform ??
      navigator.platform ??
      navigator.userAgent ??
      ''
    ).toLowerCase()
    if (/mac|iphone|ipad/.test(platformHint)) detectedPlatform = 'mac'
    else if (/win/.test(platformHint)) detectedPlatform = 'windows'
    else if (/android|linux/.test(platformHint)) detectedPlatform = 'linux'
    else detectedPlatform = 'unknown'

    const ua = String(navigator.userAgent ?? '').toLowerCase()
    if (/arm|aarch64|arm64/.test(ua)) detectedArch = 'arm64'
    else if (/x86_64|x64|amd64|win64|intel/.test(ua)) detectedArch = 'x64'
    else detectedArch = undefined

    if (isAppleSilicon()) {
      detectedArch = 'arm64'
    }
  }

  // Flatten artifacts for a platform into a simple list (and helpers to filter/pick default)
  function flattenedArtifactsForPlatform (p: PlatformGroup): DownloadArtifact[] {
    const out: DownloadArtifact[] = []
    for (const v of p.variants) {
      for (const a of v.artifacts) {
        // explicit null/empty checks for URL presence
        if (typeof a.url === 'string' && a.url !== '') out.push(a)
      }
    }
    return out
  }

  function extFromArtifact (a: DownloadArtifact): string | null {
    const s = String(a.filename ?? a.url ?? '')
    const base = s.split('?')[0]
    const parts = base
      .split('.')
      .map((p) => p.trim())
      .filter(Boolean)
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : null
  }

  function visibleArtifactsForPlatform (p: PlatformGroup): DownloadArtifact[] {
    const all = flattenedArtifactsForPlatform(p)
    if (p.platform === 'mac') {
      // For macOS show DMG where available (user requested only DMG for macOS)
      const dmg = all.filter((a) => extFromArtifact(a) === 'dmg')
      return dmg.length > 0 ? dmg : all
    }
    if (p.platform === 'windows') {
      const exe = all.filter((a) => extFromArtifact(a) === 'exe')
      return exe.length > 0 ? exe : all
    }
    return all
  }

  function pickDefaultForPlatform (p: PlatformGroup): DownloadArtifact | undefined {
    const list = visibleArtifactsForPlatform(p)
    if (list.length === 0) return undefined

    const defaultExt =
      p.platform === 'mac' ? 'dmg' : p.platform === 'windows' ? 'exe' : p.platform === 'linux' ? 'appimage' : ''

    // 1) detected arch + default ext
    if (detectedArch !== undefined) {
      const da = detectedArch
      const archMatch = list.find((a) => {
        const aExt = extFromArtifact(a)
        const archMatch = String(a.arch ?? a.archLabel ?? '')
          .toLowerCase()
          .includes(da)
        const fileNameMatch = String(a.filename ?? '')
          .toLowerCase()
          .includes(da)
        return (archMatch || fileNameMatch) && (defaultExt === '' || aExt === defaultExt)
      })
      if (archMatch) return archMatch
    }

    // 2) any with default ext
    if (defaultExt !== '') {
      const byDefault = list.find((a) => extFromArtifact(a) === defaultExt)
      if (byDefault) return byDefault
    }

    // 3) any arch match
    if (detectedArch !== undefined) {
      const da = detectedArch
      const byArch = list.find(
        (a) =>
          String(a.arch ?? a.archLabel ?? '')
            .toLowerCase()
            .includes(da) ||
          String(a.filename ?? '')
            .toLowerCase()
            .includes(da)
      )
      if (byArch) return byArch
    }

    // fallback to first available
    return list[0]
  }

  // Lifecycle -----------------------------------------------------------

  onMount(() => {
    detectPlatformAndArch()
    void fetchDownloads()
  })
</script>

<form class="container" style:padding={$deviceInfo.docWidth <= 480 ? '1.25rem' : '2rem'}>
  <div class="header">
    <div class="title-row">
      <FormButton type="button" kind="ghost" shape="round" size="small" on:click={handleBack}>
        <IconBack size="small" />
      </FormButton>
      <div class="title">
        <Label label={login.string.Downloads} variant="heading" />
      </div>
    </div>
  </div>

  {#if loading}
    <Scroller padding={'.125rem 0'} maxHeight={35}>
      <div class="platforms loading">
        <div class="platform-card">
          <div class="loader">
            <Spinner size="medium" color={$themeStore.accent === AccentColor.Intabia ? 'accent' : 'default'} />
          </div>
        </div>
      </div>
    </Scroller>
  {:else if error}
    <div class="error fs-title">{error}</div>
  {:else}
    <!-- search removed - render a flat grid of download buttons per UX request -->

    {#if platforms.length === 0}
      <div class="status">'No downloads available'</div>
    {:else}
      <Scroller padding={'.125rem 0'} maxHeight={35}>
        <div class="platforms">
          {#each platforms as p (p.platform)}
            <div class="platform-card">
              <div class="platform-header">
                <div class="platform-title">
                  <div class="platform-title-left">
                    <PlatformIcon platform={p.platform} className="platform-icon" />
                    <Label label={getEmbeddedLabel(p.name)} variant="heading" className="platform-name" />
                  </div>
                </div>
              </div>

              <div class="artifact-buttons">
                {#each visibleArtifactsForPlatform(p) as a (a.url)}
                  <div class="download-button">
                    <FormButton
                      kind={p.platform === detectedPlatform && pickDefaultForPlatform(p) === a ? 'contrast' : 'default'}
                      size="small"
                      width="100%"
                      label={getEmbeddedLabel(friendlyLabel(p, a))}
                      on:click={() => {
                        openDownload(a.url)
                      }}
                    />
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </Scroller>
    {/if}
  {/if}
</form>

<style lang="scss">
  .container {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 10rem;

    .loader {
      display: flex;
      justify-content: center;
      padding: 1rem;
    }

    /* .title and .controls removed - simplified grid-only layout */

    .status {
      color: var(--login-caption-color, var(--content-muted-color, #6b7280));
      padding: 0.5rem 0;
    }

    .header {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .header .title-row {
      position: relative;
      min-height: 2.25rem;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    /* Icon/back button positioned exactly as in other login screens */
    .header .title-row > .form-button {
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      color: var(--login-caret-color, inherit); /* Intabia: black; other themes: inherit */
      padding: 0.25rem;
      min-width: 2.25rem;
      height: 2.25rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .header .title {
      margin: 0 auto;
      text-align: center;
      font-weight: var(--login-title-font-weight, 500);
      font-size: var(--login-title-font-size, 1.25rem);
      color: var(--login-caption-color, var(--theme-caption-color));
    }

    /* Centered loading state inside the list (keeps layout stable while fetching) */
    .platforms.loading {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .platforms.loading .platform-card {
      padding: 1.5rem;
      min-height: 6rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .platforms {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .platform-card {
      padding: 0.75rem;
      /* background: var(--card-bg, rgba(255, 255, 255, 0.02)); */
      border-radius: 0.5rem;
    }

    .platform-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
    }

    .platform-title {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    .platform-title-left {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .platform-name {
      font-weight: 600;
    }

    .platform-icon {
      color: var(--login-heading-color, var(--login-content-color));
      display: inline-flex;
    }

    .artifact-buttons {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .download-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
    }
  }

  @media (max-width: 480px) {
    .container {
      padding: 0.75rem;
    }
  }
</style>
