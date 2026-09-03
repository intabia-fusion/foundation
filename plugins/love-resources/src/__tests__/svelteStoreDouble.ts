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

// Svelte 4 ships `svelte/store` as ESM-only and ts-jest cannot load it. Unlike the repo-wide
// double, `derived` here re-runs on every dependency notification, as real Svelte does.

export type Subscriber<T> = (value: T) => void
export type Unsubscriber = () => void
export type Updater<T> = (value: T) => T

export interface Readable<T> {
  subscribe: (run: Subscriber<T>) => Unsubscriber
}

export interface Writable<T> extends Readable<T> {
  set: (value: T) => void
  update: (updater: Updater<T>) => void
}

export function writable<T> (initial: T): Writable<T> {
  let value = initial
  const subs = new Set<Subscriber<T>>()
  return {
    subscribe (run: Subscriber<T>) {
      subs.add(run)
      run(value)
      return () => subs.delete(run)
    },
    set (next: T) {
      value = next
      subs.forEach((run) => {
        run(value)
      })
    },
    update (fn: Updater<T>) {
      value = fn(value)
      subs.forEach((run) => {
        run(value)
      })
    }
  }
}

export function derived<T> (stores: Readable<any> | Array<Readable<any>>, fn: (values: any) => T): Readable<T> {
  const arr = Array.isArray(stores) ? stores : [stores]
  const subs = new Set<Subscriber<T>>()
  const values: any[] = new Array(arr.length)
  let value: T
  let unsubscribers: Unsubscriber[] = []
  let started = false

  const recompute = (): void => {
    value = Array.isArray(stores) ? fn(values) : fn(values[0])
    subs.forEach((run) => {
      run(value)
    })
  }

  // Lazy, like real Svelte: sources are subscribed only on the first subscriber. Module-scope
  // derived stores reference bindings declared further down, so eager evaluation would break.
  const start = (): void => {
    if (started) return
    started = true
    let initializing = true
    unsubscribers = arr.map((store, i) =>
      store.subscribe((v: any) => {
        values[i] = v
        if (!initializing) recompute()
      })
    )
    initializing = false
    recompute()
  }

  const stop = (): void => {
    unsubscribers.forEach((u) => {
      u()
    })
    unsubscribers = []
    started = false
  }

  return {
    subscribe (run: Subscriber<T>) {
      const isFirst = subs.size === 0
      subs.add(run)
      if (isFirst) start()
      run(value)
      return () => {
        subs.delete(run)
        if (subs.size === 0) stop()
      }
    }
  }
}

export function get<T> (store: Readable<T>): T {
  let value!: T
  const unsubscribe = store.subscribe((v: T) => {
    value = v
  })
  unsubscribe()
  return value
}
