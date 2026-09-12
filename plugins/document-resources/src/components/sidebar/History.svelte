<!--
//
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
//
-->
<script lang="ts">
  import { type DocumentVersion } from '@hcengineering/collaborator-client'
  import { type Markup, makeDocCollabId } from '@hcengineering/core'
  import { Document } from '@hcengineering/document'
  import { getMarkup, getMarkupVersionContent, getMarkupVersions } from '@hcengineering/presentation'
  import { areEqualMarkups, markupToJSON, type MarkupNode } from '@hcengineering/text'
  import {
    Button,
    ExpandCollapse,
    IconCollapseArrow,
    Label,
    Loading,
    Scroller,
    TimeSince,
    showPopup
  } from '@hcengineering/ui'
  import { MarkupDiffPresenter } from '@hcengineering/view-resources'
  import { createEventDispatcher, tick } from 'svelte'

  import document from '../../plugin'
  import VersionPreview from './VersionPreview.svelte'

  export let value: Document
  export let readonly: boolean = false
  // live editor state, includes edits not yet flushed to storage
  export let getCurrentContent: (() => MarkupNode | undefined) | undefined = undefined

  const dispatch = createEventDispatcher()

  let versions: DocumentVersion[] = []
  let loading = true
  let expanded: DocumentVersion | undefined
  let expandedMarkup: Markup | undefined
  // the version right before the expanded one, so the inline diff shows what this version changed
  let previousMarkup: Markup | undefined
  let busy = false
  // any row works: used only to reach the enclosing .scroll container
  let rowEl: HTMLElement | undefined

  $: collabId = makeDocCollabId(value, 'content')

  $: void loadVersions(value._id)

  async function loadVersions (id: Document['_id']): Promise<void> {
    const collab = makeDocCollabId(value, 'content')
    loading = true
    expanded = undefined
    expandedMarkup = undefined
    previousMarkup = undefined
    try {
      const loaded = await getMarkupVersions(collab)
      // another document may have been opened while we were fetching
      if (value._id !== id) return
      versions = loaded
    } finally {
      if (value._id === id) {
        loading = false
      }
    }
  }

  function formatSize (bytes: number): string {
    const abs = Math.abs(bytes)
    const sign = bytes < 0 ? '-' : ''
    if (abs < 1024) return `${sign}${abs} B`
    if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`
    return `${sign}${(abs / 1024 / 1024).toFixed(1)} MB`
  }

  // versions are sorted newest first, so the previous one sits at i + 1
  function sizeDelta (i: number): number {
    const prev = versions[i + 1]
    return prev === undefined ? 0 : versions[i].size - prev.size
  }

  async function loadMarkup (version: DocumentVersion): Promise<Markup> {
    return await getMarkupVersionContent(collabId, version.blobId)
  }

  async function loadVersion (version: DocumentVersion): Promise<MarkupNode> {
    return markupToJSON(await loadMarkup(version))
  }

  async function toggle (version: DocumentVersion): Promise<void> {
    if (expanded?.blobId === version.blobId) {
      expanded = undefined
      expandedMarkup = undefined
      previousMarkup = undefined
      return
    }

    expanded = version
    expandedMarkup = undefined
    previousMarkup = undefined

    const i = versions.findIndex((v) => v.blobId === version.blobId)
    const prev = versions[i + 1]
    const [markup, prevMarkup] = await Promise.all([
      loadMarkup(version),
      prev !== undefined ? loadMarkup(prev) : Promise.resolve(undefined)
    ])

    // a later click may have won while we were fetching
    if (expanded === version) {
      // The diff editor mounts asynchronously and the browser shifts the list only a couple
      // of frames later, so pin the position for a short window instead of a single restore.
      const scroll = rowEl?.closest<HTMLElement>('.scroll')
      const keepTop = scroll?.scrollTop ?? 0

      expandedMarkup = markup
      previousMarkup = prevMarkup

      if (scroll != null) {
        const deadline = Date.now() + 500
        const pin = (): void => {
          if (scroll.scrollTop !== keepTop) {
            scroll.scrollTop = keepTop
          }
          if (Date.now() < deadline) {
            requestAnimationFrame(pin)
          }
        }
        void tick().then(() => {
          requestAnimationFrame(pin)
        })
      }
    }
  }

  // resolved lazily: the editor may not have been ready when the tab was opened
  async function getCurrent (): Promise<MarkupNode> {
    return getCurrentContent?.() ?? markupToJSON(await getMarkup(collabId, undefined))
  }

  function preview (version: DocumentVersion, markup: Markup): void {
    showPopup(
      VersionPreview,
      { version, content: markupToJSON(markup), versions, getCurrent, readonly, loadVersion },
      undefined,
      (result?: string) => {
        if (result === 'restore') {
          dispatch('restore', markupToJSON(markup))
        }
      }
    )
  }

  async function restore (version: DocumentVersion): Promise<void> {
    if (busy) return
    busy = true
    try {
      dispatch('restore', await loadVersion(version))
    } finally {
      busy = false
    }
  }
</script>

<div class="h-full flex-col clear-mins">
  <div class="header">
    <div class="title"><Label label={document.string.History} /></div>
  </div>

  <div class="divider" />

  {#if loading}
    <Loading />
  {:else if versions.length > 0}
    <Scroller>
      {#each versions as version, i}
        {@const isExpanded = expanded?.blobId === version.blobId}
        {@const delta = sizeDelta(i)}
        <div class="version" class:expanded={isExpanded} bind:this={rowEl}>
          <button
            class="row"
            type="button"
            aria-expanded={isExpanded}
            on:click={() => {
              void toggle(version)
            }}
          >
            <div class="flex-between">
              <div class="flex-row-center">
                <div class="chevron" class:expanded={isExpanded}>
                  <IconCollapseArrow size={'small'} />
                </div>
                <!-- oldest version is #1, the list is sorted newest first -->
                <div class="number">#{versions.length - i}</div>
                <div class="time ml-2">
                  <TimeSince value={version.createdOn} />
                </div>
                <div class="size ml-2">{formatSize(version.size)}</div>
                {#if delta !== 0}
                  <!-- a large negative delta means content was lost in this version -->
                  <div class="delta ml-2" class:negative={delta < 0}>
                    {delta > 0 ? '+' : ''}{formatSize(delta)}
                  </div>
                {/if}
              </div>
              {#if i === 0}
                <div class="current"><Label label={document.string.CurrentVersion} /></div>
              {/if}
            </div>
          </button>
          <ExpandCollapse {isExpanded}>
            <!-- content renders only while open; the wrapper stays put so the list does not jump -->
            {#if isExpanded}
              <div class="mt-2 flex-row-center flex-gap-2">
                <Button
                  label={document.string.PreviewVersion}
                  kind={'regular'}
                  size={'small'}
                  disabled={expandedMarkup === undefined}
                  on:click={() => {
                    if (expandedMarkup !== undefined) preview(version, expandedMarkup)
                  }}
                />
                {#if !readonly}
                  <Button
                    label={document.string.RestoreVersion}
                    kind={'primary'}
                    size={'small'}
                    disabled={busy || expandedMarkup === undefined}
                    on:click={() => {
                      void restore(version)
                    }}
                  />
                {/if}
              </div>
              <div class="caption"><Label label={document.string.ChangedInThisVersion} /></div>
              <div class="diff">
                {#if expandedMarkup === undefined}
                  <Loading />
                {:else if previousMarkup !== undefined && areEqualMarkups(expandedMarkup, previousMarkup)}
                  <div class="same"><Label label={document.string.SameAsCurrent} /></div>
                {:else}
                  <!-- showOnlyDiff drops unchanged top-level blocks so long documents stay readable -->
                  <MarkupDiffPresenter
                    value={expandedMarkup}
                    prevValue={previousMarkup}
                    showOnlyDiff
                    withShowMore={false}
                  />
                {/if}
              </div>
            {/if}
          </ExpandCollapse>
        </div>
      {/each}
    </Scroller>
  {:else}
    <div class="flex-col justify-center flex-grow text-center">
      <div class="label nowrap fs-bold">
        <Label label={document.string.NoHistory} />
      </div>
    </div>
  {/if}
</div>

<style lang="scss">
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 1.25rem;
    height: 3rem;
    min-height: 3rem;
    border-bottom: 1px solid var(--theme-divider-color);

    .title {
      flex-grow: 1;
      font-weight: 500;
      color: var(--caption-color);
      user-select: none;
    }
  }
  .version {
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--theme-divider-color);

    &.expanded {
      background-color: var(--theme-bg-accent-color);
    }
  }
  .row {
    // native button semantics: keyboard support comes for free, strip the default chrome
    display: block;
    width: 100%;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
    // the row is a click target, dragging over it should not select text.
    // explicit prefix: Safari needs it, and it must be set on every descendant
    // because Safari ignores an inherited none once a drag starts elsewhere
    -webkit-user-select: none;
    user-select: none;

    * {
      -webkit-user-select: none;
      user-select: none;
    }

    &:hover .time {
      color: var(--caption-color);
    }
  }
  .chevron {
    display: flex;
    margin-right: 0.25rem;
    color: var(--theme-trans-color);
    transform-origin: center;
    transition: transform 0.15s ease-in-out;

    &.expanded {
      transform: rotate(90deg);
    }
  }
  .number {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--caption-color);
  }
  .time {
    font-size: 0.75rem;
    color: var(--theme-trans-color);
  }
  .current {
    font-size: 0.625rem;
    color: var(--theme-trans-color);
  }
  .size {
    font-size: 0.625rem;
    color: var(--theme-trans-color);
  }
  .same {
    padding: 0.5rem;
    font-size: 0.75rem;
    text-align: center;
    color: var(--theme-trans-color);
  }
  .caption {
    margin-top: 0.5rem;
    font-size: 0.625rem;
    text-transform: uppercase;
    color: var(--theme-trans-color);
  }
  .delta {
    font-size: 0.625rem;
    color: var(--theme-won-color);

    &.negative {
      color: var(--theme-lost-color);
    }
  }
  .diff {
    margin-top: 0.25rem;
    padding: 0.5rem;
    max-height: 24rem;
    overflow: auto;
    background-color: var(--theme-bg-color);
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.25rem;
  }
</style>
