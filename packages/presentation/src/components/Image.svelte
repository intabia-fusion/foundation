<!--
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
-->
<script lang="ts">
  import type { Blob, Ref } from '@hcengineering/core'
  import { Blurhash, Image, Loading, lazyObserver, persistentLazyObserver, isLazyEnabled } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import { getBlobRef } from '../preview'

  export let blob: Ref<Blob>
  export let alt: string | undefined = undefined
  export let fit: string = 'contain'
  export let width: number
  export let height: number
  export let responsive: boolean = false
  export let loading: 'lazy' | 'eager' = 'eager'
  export let blurhash: string | undefined = undefined
  export let showLoading: boolean = false
  export let persistent: boolean = true
  export let tiny: boolean = false

  const dispatch = createEventDispatcher()

  let visible = !isLazyEnabled() || loading === 'eager'
  let blobSrc: { src: string, srcset: string } | undefined

  $: if (visible) {
    void getBlobRef(blob, alt, width, height).then((val) => {
      blobSrc = val
    })
  }

  $: if (!visible) {
    loaded = false
  }

  let loaded = false

  function handleLoad (): void {
    loaded = true
    dispatch('load')
  }

  function handleLoadStart (): void {
    loaded = false
    dispatch('loadstart')
  }

  function lazyObserverAction (node: Element, persistent: boolean): any {
    let activeObserver = persistent
      ? persistentLazyObserver(node, (val) => {
        visible = val
      })
      : lazyObserver(node, (val, unsubscribe) => {
        if (val) {
          visible = true
          unsubscribe?.()
        }
      })

    return {
      destroy () {
        activeObserver?.destroy?.()
      },
      update (newPersistent: boolean) {
        if (newPersistent !== persistent) {
          activeObserver?.destroy?.()
          persistent = newPersistent
          activeObserver = persistent
            ? persistentLazyObserver(node, (val) => {
              visible = val
            })
            : lazyObserver(node, (val, unsubscribe) => {
              if (val) {
                visible = true
                unsubscribe?.()
              }
            })
        }
      }
    }
  }
</script>

<div class="container relative w-full h-full" class:tiny use:lazyObserverAction={persistent}>
  {#if visible}
    {#if !loaded}
      {#if blurhash !== undefined}
        <div class="overlay">
          <!-- Do not pass width/height. Decoding blurhash at full display size on the main thread is extremely slow. -->
          <!-- The default 32x32 canvas size is lightweight and stretched using CSS anyway. -->
          <Blurhash {blurhash} />
        </div>
      {:else if showLoading}
        <div class="overlay">
          <Loading />
        </div>
      {/if}
    {/if}

    <Image
      src={blobSrc?.src}
      srcset={blobSrc?.srcset}
      {alt}
      width={responsive ? '100%' : width}
      height={responsive ? '100%' : height}
      {loading}
      {fit}
      on:error
      on:load={handleLoad}
      on:loadstart={handleLoadStart}
    />
  {/if}
</div>

<style lang="scss">
  .container {
    border-radius: inherit;

    &.tiny {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 0;
    }
  }
  .overlay {
    border-radius: inherit;
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
  }
</style>
