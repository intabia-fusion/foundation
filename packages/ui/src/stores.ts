// Copyright © 2025 Hardcore Engineering Inc.
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

import { readable, writable } from 'svelte/store'

export const isAppFocusedStore = writable(true)

export const devicePixelRatioStore = readable(
  typeof window !== 'undefined' ? (window.devicePixelRatio ?? 1) : 1,
  (set) => {
    if (typeof window === 'undefined') return

    let mediaQuery: MediaQueryList | undefined

    function updateDpr (): void {
      const dpr = window.devicePixelRatio ?? 1
      set(dpr)
      if (mediaQuery !== undefined) {
        mediaQuery.removeEventListener('change', updateDpr)
      }
      mediaQuery = window.matchMedia(`(resolution: ${dpr}dppx)`)
      mediaQuery.addEventListener('change', updateDpr)
    }

    updateDpr()

    return () => {
      if (mediaQuery !== undefined) {
        mediaQuery.removeEventListener('change', updateDpr)
      }
    }
  }
)
