<!--
// Copyright © 2024 Hardcore Engineering Inc.
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
  import type { Attachment } from '@hcengineering/attachment'
  import type { BlobType, WithLookup } from '@hcengineering/core'
  import { Image } from '@hcengineering/presentation'
  import { Blurhash, devicePixelRatioStore } from '@hcengineering/ui'

  import BrokenImage from './icons/BrokenImage.svelte'
  import { calculateAttachmentDimensions } from '../utils'
  import { AttachmentImageSize } from '../types'

  export let value: WithLookup<Attachment> | BlobType
  export let size: AttachmentImageSize = 'auto'

  const MIN_IMAGE_REM = 3

  $: dimensions = calculateAttachmentDimensions(value?.metadata, size, $devicePixelRatioStore)

  function toStyle (size: 'auto' | number): string {
    return size === 'auto' ? 'auto' : `${size}px`
  }

  let loading = false
  let error = false

  function handleLoadStart (): void {
    loading = true
  }

  function getMinImagePx (): number {
    if (typeof document === 'undefined') return 50
    const fontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) ?? 16
    return MIN_IMAGE_REM * fontSize
  }

  $: isTinyImage =
    dimensions.fit === 'contain' && (dimensions.width < getMinImagePx() || dimensions.height < getMinImagePx())

  function handleLoad (): void {
    loading = false
  }

  function handleError (): void {
    loading = false
    error = true
  }
</script>

<div
  class="container"
  class:loading
  class:error
  class:tiny={isTinyImage}
  data-id="attachment-image-preview"
  style="
   width: {toStyle(dimensions.width)};
   height: {toStyle(dimensions.height)};
   max-width: 100%;
   aspect-ratio: {dimensions.width} / {dimensions.height};"
>
  {#if error}
    {#if value.metadata?.thumbnail?.blurhash !== undefined}
      <Blurhash blurhash={value.metadata.thumbnail.blurhash} />
    {/if}
    <div class="image-overlay">
      <BrokenImage size={'large'} />
    </div>
  {:else}
    <Image
      blob={value.file}
      loading="lazy"
      alt={value.name}
      fit={dimensions.fit}
      width={dimensions.width}
      height={dimensions.height}
      blurhash={value.metadata?.thumbnail?.blurhash}
      showLoading={loading}
      tiny={isTinyImage}
      on:load={handleLoad}
      on:error={handleError}
      on:loadstart={handleLoadStart}
    />
  {/if}
</div>

<style lang="scss">
  .container {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    min-width: 3rem;
    min-height: 3rem;
    border-radius: 0.75rem;
    overflow: hidden;

    &.tiny {
      border: 1px solid var(--theme-divider-color);
    }

    &.loading,
    &.error {
      background-color: var(--theme-link-preview-bg-color);
    }

    .image-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
    }
  }
</style>
