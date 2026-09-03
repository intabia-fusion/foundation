//
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
//

import { type AnalyticProvider } from '@hcengineering/analytics'

declare global {
  interface Window {
    ym?: any
  }
}

export class YandexMetrikaProvider implements AnalyticProvider {
  private counterId: number | undefined

  init (config: Record<string, any>): boolean {
    const id = config.YANDEX_METRIKA_ID
    if (id === null || id === '') return false

    this.counterId = typeof id === 'string' ? parseInt(id, 10) : id
    if (this.counterId === undefined || isNaN(this.counterId)) return false

    // Only load script immediately if we land directly on a tracking path
    if (typeof window !== 'undefined') {
      const path = window.location.pathname
      if (this.isTrackingPath(path)) {
        this.loadMetrika()
        window.ym(this.counterId, 'hit', window.location.href, {
          referer: document.referrer,
          title: document.title
        })
      }
    }

    return true
  }

  private isTrackingPath (path: string): boolean {
    if (path.includes('/selectWorkspace') || path.includes('/workbench')) return false

    return (
      path.includes('/login') ||
      path.includes('/signup') ||
      path.includes('/join') ||
      path.includes('/createWorkspace') ||
      path.includes('/onboard')
    )
  }

  private loadMetrika (): void {
    if (typeof window === 'undefined') return

    const scriptUrl = 'https://mc.yandex.ru/metrika/tag.js'
    const scripts = document.getElementsByTagName('script')
    let alreadyLoaded = false
    for (let i = 0; i < scripts.length; i++) {
      if (scripts[i].src.includes('mc.yandex.ru/metrika/tag.js')) {
        alreadyLoaded = true
        break
      }
    }

    if (!alreadyLoaded) {
      if (window.ym === undefined || window.ym === null) {
        const ymQueue: any[] = []
        const ymFunc = function (): void {
          // eslint-disable-next-line prefer-rest-params
          ymQueue.push(arguments)
        }
        ymFunc.a = ymQueue
        window.ym = ymFunc
      }
      window.ym.l = Date.now()

      const script = document.createElement('script')
      script.async = true
      script.src = scriptUrl

      const firstScript = document.getElementsByTagName('script')[0] as HTMLScriptElement | undefined
      if (firstScript !== undefined && firstScript !== null) {
        const parent = firstScript.parentNode
        if (parent !== null && parent !== undefined) {
          parent.insertBefore(script, firstScript)
        } else {
          document.head.appendChild(script)
        }
      } else {
        document.head.appendChild(script)
      }
    }

    if (this.counterId !== undefined) {
      window.ym(this.counterId, 'init', {
        clickmap: false,
        trackLinks: false,
        accurateTrackBounce: false,
        webvisor: false,
        defer: true
      })
    }
  }

  private unloadMetrika (): void {
    if (typeof window === 'undefined') return

    const scripts = document.getElementsByTagName('script')
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i]
      if (script.src.includes('mc.yandex.ru/metrika/tag.js')) {
        const parent = script.parentNode
        if (parent !== null && parent !== undefined) {
          parent.removeChild(script)
        }
        break
      }
    }

    try {
      delete window.ym
      delete (window as any).Ya
      delete (window as any).yandex_metrika_callbacks
      delete (window as any).yandex_metrika_callbacks2
    } catch (e) {
      window.ym = undefined
    }
  }

  setUser (email: string, data: any): void {}

  setAlias (distinctId: string, alias: string): void {}

  setTag (key: string, value: string): void {}

  setWorkspace (ws: string, guest: boolean): void {}

  handleEvent (event: string, params: Record<string, any> = {}): void {
    if (typeof window === 'undefined' || this.counterId === undefined || window.ym === undefined) return

    // 1) Submitted form with registration data (either standard email or OTP code success validation)
    if ((event === 'signup.viaEmail' || event === 'signup.viaOtp') && params?.ok === true) {
      let method = 'email'
      if (event === 'signup.viaOtp') {
        method = 'otp'
      }
      const isInvite = window.location.pathname.includes('/join')
      window.ym(this.counterId, 'reachGoal', 'signup_submit', { method, invite: isInvite })
    } else if (event.startsWith('signup.') && event.endsWith('.completed')) {
      const split = event.split('.')
      const method = split[1] !== undefined && split[1] !== '' ? split[1] : 'oauth'
      const isInvite = window.location.pathname.includes('/join')
      window.ym(this.counterId, 'reachGoal', 'signup_submit', { method, invite: isInvite })
    }

    // 2) Created space
    if (event === 'onboard.createWorkspace' && params?.ok === true) {
      window.ym(this.counterId, 'reachGoal', 'workspace_created')
    }
  }

  handleError (_error: Error): void {}

  navigate (path: string): void {
    if (typeof window === 'undefined' || this.counterId === undefined) return

    // Lazy load the script and track hit only when visiting a tracking page
    if (this.isTrackingPath(path)) {
      this.loadMetrika()
      if (window.ym !== undefined) {
        let fullUrl: string
        try {
          fullUrl = new URL(path, window.location.origin).href
        } catch {
          fullUrl = path
        }
        window.ym(this.counterId, 'hit', fullUrl, {
          referer: document.referrer,
          title: document.title
        })
      }
    } else if (path.includes('/workbench')) {
      // Delay unloading by 3 seconds to make sure that the network requests
      // for any pending goals/hits are dispatched successfully by the browser.
      setTimeout(() => {
        if (typeof window !== 'undefined' && window.location.pathname.includes('/workbench')) {
          this.unloadMetrika()
        }
      }, 3000)
    }
  }

  logout (): void {}
}
