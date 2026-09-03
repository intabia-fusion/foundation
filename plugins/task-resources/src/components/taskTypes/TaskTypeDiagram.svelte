<!--
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Ref } from '@hcengineering/core'
  import { TaskType } from '@hcengineering/task'
  import {
    Button,
    getColorNumberByText,
    getPlatformColorDef,
    IconError,
    Label,
    languageStore,
    Loading,
    themeStore,
    Toggle
  } from '@hcengineering/ui'
  import plugin from '../../plugin'

  const COMPACT_LAYOUT_STORAGE_KEY = 'task-types-diagram-compact'
  const GROUP_ANY_STORAGE_KEY = 'task-types-diagram-group-any'

  function loadCompactLayoutPreference (): boolean {
    try {
      const saved = localStorage.getItem(COMPACT_LAYOUT_STORAGE_KEY)
      if (saved !== null) {
        return saved === 'true'
      }
    } catch {
      // Ignore storage errors in restricted contexts
    }
    return false
  }

  function saveCompactLayoutPreference (value: boolean): void {
    try {
      localStorage.setItem(COMPACT_LAYOUT_STORAGE_KEY, String(value))
    } catch {
      // Ignore storage errors
    }
  }

  function loadGroupAnyPreference (): boolean {
    try {
      const saved = localStorage.getItem(GROUP_ANY_STORAGE_KEY)
      if (saved !== null) {
        return saved === 'true'
      }
    } catch {
      // Ignore storage errors in restricted contexts
    }
    return false
  }

  function saveGroupAnyPreference (value: boolean): void {
    try {
      localStorage.setItem(GROUP_ANY_STORAGE_KEY, String(value))
    } catch {
      // Ignore storage errors
    }
  }

  export let taskTypes: TaskType[] = []
  export let focusTypeId: Ref<TaskType> | undefined = undefined

  let compactLayout = loadCompactLayoutPreference()
  let groupAny = loadGroupAnyPreference()
  let imageUrl: string | undefined = undefined
  let errorMsg: string | undefined = undefined
  let showDetails = false
  let loading = true
  let currentObjectUrl: string | undefined = undefined
  let renderSequence = 0

  $: saveCompactLayoutPreference(compactLayout)
  $: saveGroupAnyPreference(groupAny)

  $: hasAnyParents = taskTypes.some((t) => t.allowAnyParent === true)
  $: hasSelfRefs = taskTypes.some((t) => t.allowAnyParent === true || (t.allowedAsChildOf ?? []).includes(t._id))

  function sanitizeLabel (str: string): string {
    if (str === '') return ''
    return str
      .replace(/"/g, '#quot;')
      .replace(/[\r\n]+/g, ' ')
      .trim()
  }

  function sanitizeColor (color: string | undefined, fallback: string): string {
    if (color === undefined || color === '') return fallback
    const trimmed = color.trim()
    if (trimmed.includes('gradient') || trimmed.includes('(') || trimmed.includes(',')) {
      const match = trimmed.match(/#(?:[0-9a-fA-F]{3,8})/)
      if (match !== null) return match[0]
      return fallback
    }
    return trimmed
  }

  function sortTaskTypesByHierarchy (taskTypes: TaskType[]): TaskType[] {
    const map = new Map<Ref<TaskType>, TaskType>()
    taskTypes.forEach((t) => map.set(t._id, t))

    const depthCache = new Map<Ref<TaskType>, number>()
    const visiting = new Set<Ref<TaskType>>()

    function getDepth (t: TaskType): number {
      const cached = depthCache.get(t._id)
      if (cached !== undefined) return cached
      if (visiting.has(t._id)) return 0

      if (t.allowAnyParent === true) {
        return 100 // place universal subtasks at bottom rank
      }

      const parents = (t.allowedAsChildOf ?? []).filter((p) => p !== t._id && map.has(p))
      if (parents.length === 0) {
        depthCache.set(t._id, 0)
        return 0
      }

      visiting.add(t._id)
      let maxParentDepth = 0
      for (const pId of parents) {
        const parent = map.get(pId)
        if (parent !== undefined) {
          maxParentDepth = Math.max(maxParentDepth, getDepth(parent) + 1)
        }
      }
      visiting.delete(t._id)

      depthCache.set(t._id, maxParentDepth)
      return maxParentDepth
    }

    return [...taskTypes].sort((a, b) => {
      const da = getDepth(a)
      const db = getDepth(b)
      if (da !== db) return da - db
      return a.name.localeCompare(b.name)
    })
  }

  function generateMermaidCode (
    taskTypes: TaskType[],
    isDark: boolean,
    compact: boolean,
    groupAny: boolean,
    focusId?: Ref<TaskType>
  ): string {
    const sortedTypes = sortTaskTypesByHierarchy(taskTypes)
    const nodeIds = new Map<Ref<TaskType>, string>()
    sortedTypes.forEach((t, idx) => nodeIds.set(t._id, `tt_${idx}`))

    const lines: string[] = [
      '---',
      'config:',
      '  layout: elk',
      '  theme: redux',
      '  elk:',
      '    nodePlacementStrategy: BRANDES_KOEPF'
    ]

    if (compact) {
      lines.push('    mergeEdges: true')
    }

    lines.push('---', 'flowchart TB')

    // Task type nodes with platform background/foreground colors
    for (const t of sortedTypes) {
      const nodeId = nodeIds.get(t._id)
      if (nodeId === undefined) continue

      const isSelf = t.allowAnyParent === true || (t.allowedAsChildOf ?? []).includes(t._id)
      const strokeColor = isDark ? '#f8fafc' : '#0f172a'
      const icon = isSelf
        ? ` <span style='display:inline-flex;align-items:center;vertical-align:middle;position:relative;top:-1.5px;margin-left:4px;background:transparent !important;'><svg style='display:block;background:transparent !important;background-color:transparent !important;fill:none !important;border:none !important;' width='14' height='14' viewBox='0 0 20 20' fill='none' xmlns='http://www.w3.org/2000/svg'><path style='fill:none !important;stroke:${strokeColor} !important;' fill='none' d='M3.26794 12.0431C3.7049 13.4662 4.58316 14.7135 5.77571 15.6046C6.96827 16.4957 8.41333 16.9844 9.90195 17.0001C11.6239 17.0213 13.2935 16.4081 14.5924 15.2774C15.8913 14.1467 16.7287 12.5775 16.9449 10.8691C17.1577 9.16057 16.7333 7.4336 15.753 6.01828C14.7727 4.60295 13.3052 3.59854 11.6309 3.19706C9.95636 2.792 8.19129 3.0168 6.6717 3.82869C5.1521 4.64058 3.98408 5.98286 3.38994 7.60006' stroke='${strokeColor}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/><path style='fill:none !important;stroke:${strokeColor} !important;' fill='none' d='M3 4V8H7' stroke='${strokeColor}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg></span>`
        : ''
      const label = sanitizeLabel(t.name) + icon
      lines.push(`  ${nodeId}(["${label}"])`)

      const colorNum = t.color !== undefined && typeof t.color !== 'string' ? t.color : getColorNumberByText(t.name)
      const colorDef = getPlatformColorDef(colorNum, isDark)

      const fill = sanitizeColor(colorDef.background, isDark ? '#1e293b' : '#f1f5f9')
      const textColor = sanitizeColor(colorDef.color, isDark ? '#f8fafc' : '#0f172a')
      const stroke = sanitizeColor(colorDef.title, isDark ? '#475569' : '#64748b')

      lines.push(`  style ${nodeId} fill:${fill},color:${textColor},stroke:${stroke}`)
    }

    // Hierarchy relationships (Parent -> Child)
    let anyCount = 0

    for (const child of sortedTypes) {
      const toNode = nodeIds.get(child._id)
      if (toNode === undefined) continue

      if (child.allowAnyParent === true) {
        if (groupAny) {
          if (focusId !== undefined && child._id !== focusId) {
            const fromNode = nodeIds.get(focusId)
            if (fromNode !== undefined) {
              lines.push(`  ${fromNode} --> ${toNode}`)
            }
          } else {
            const anyNodeId = `any_${anyCount++}`
            lines.push(`  ${anyNodeId}(["any"])`)
            const anyStyle = isDark
              ? 'fill:#1e293b,color:#cbd5e1,stroke:#94a3b8,stroke-width:1px,font-size:8px'
              : 'fill:#ffffff,color:#1e293b,stroke:#242538,stroke-width:1px,font-size:8px'
            lines.push(`  style ${anyNodeId} ${anyStyle}`)
            lines.push(`  ${anyNodeId} --> ${toNode}`)
          }
        } else {
          for (const parent of sortedTypes) {
            if (parent._id === child._id) continue
            const fromNode = nodeIds.get(parent._id)
            if (fromNode !== undefined) {
              lines.push(`  ${fromNode} --> ${toNode}`)
            }
          }
        }
      } else {
        const parents = child.allowedAsChildOf ?? []
        for (const parentId of parents) {
          if (parentId === child._id) continue // Self-nesting is indicated by the ⟳ badge
          const fromNode = nodeIds.get(parentId)
          if (fromNode !== undefined) {
            lines.push(`  ${fromNode} --> ${toNode}`)
          }
        }
      }
    }

    return lines.join('\n')
  }

  function getMermaidThemeVariables (isDark: boolean): Record<string, string> {
    const fontFamily = 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'

    if (isDark) {
      return {
        fontFamily,
        fontSize: '10px',
        primaryColor: '#1e293b',
        primaryTextColor: '#f8fafc',
        primaryBorderColor: '#475569',
        lineColor: '#94a3b8',
        secondaryColor: '#0f172a',
        tertiaryColor: '#1e293b',
        edgeLabelBackground: '#1e293b',
        nodeBorder: '#475569',
        clusterBkg: '#0f172a'
      }
    }

    return {
      fontFamily,
      fontSize: '10px',
      primaryColor: '#f1f5f9',
      primaryTextColor: '#0f172a',
      primaryBorderColor: '#64748b',
      lineColor: '#334155',
      secondaryColor: '#f8fafc',
      tertiaryColor: '#e2e8f0',
      edgeLabelBackground: '#ffffff',
      nodeBorder: '#64748b',
      clusterBkg: '#f8fafc'
    }
  }

  function getCustomSvgStyles (isDark: boolean): string {
    const strokeColor = isDark ? '#94a3b8' : '#242538'
    const fillColor = isDark ? '#1e293b' : '#ffffff'
    const textColor = isDark ? '#cbd5e1' : '#1e293b'

    return `
      g.node[id*="any"] {
        overflow: visible !important;
      }
      g.node[id*="any"] rect, g.node[id*="any"] path, [id*="any"] path, [id*="any"] polygon {
        fill: ${fillColor} !important;
        fill-opacity: 1 !important;
        stroke: ${strokeColor} !important;
        stroke-width: 1px !important;
      }
      g.node[id*="any"] text, [id*="any"] text, [id*="any"] .nodeLabel, [id*="any"] span {
        fill: ${textColor} !important;
        color: ${textColor} !important;
        font-size: 8px !important;
        overflow: visible !important;
        dominant-baseline: central !important;
        text-anchor: middle !important;
      }
      g.node[id*="any"] foreignObject {
        overflow: visible !important;
      }
    `
  }

  function svgToPng (blobUrl: string, rawSvg: string): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        try {
          const parser = new DOMParser()
          const doc = parser.parseFromString(rawSvg, 'image/svg+xml')
          const svgEl = doc.querySelector('svg')

          let width = img.width || 800
          let height = img.height || 600

          if (svgEl !== null) {
            const viewBox = svgEl.getAttribute('viewBox')
            if (viewBox !== null) {
              const parts = viewBox.split(/[\s,]+/).map(Number)
              if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
                width = parts[2]
                height = parts[3]
              }
            } else {
              const wAttr = parseFloat(svgEl.getAttribute('width') ?? '')
              const hAttr = parseFloat(svgEl.getAttribute('height') ?? '')
              if (wAttr > 0 && hAttr > 0) {
                width = wAttr
                height = hAttr
              }
            }
          }

          const scale = 2
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(width * scale)
          canvas.height = Math.ceil(height * scale)
          const ctx = canvas.getContext('2d')
          if (ctx === null) {
            resolve(blobUrl)
            return
          }

          ctx.scale(scale, scale)
          ctx.drawImage(img, 0, 0, width, height)
          resolve(canvas.toDataURL('image/png'))
        } catch {
          resolve(blobUrl)
        }
      }
      img.onerror = () => {
        resolve(blobUrl)
      }
      img.src = blobUrl
    })
  }

  function revokeObjectUrl (): void {
    if (currentObjectUrl !== undefined) {
      URL.revokeObjectURL(currentObjectUrl)
      currentObjectUrl = undefined
    }
  }

  async function renderDiagram (): Promise<void> {
    const seq = ++renderSequence
    loading = true
    errorMsg = undefined

    if (taskTypes.length === 0) {
      loading = false
      imageUrl = undefined
      return
    }

    try {
      const isDark = $themeStore.dark
      const code = generateMermaidCode(taskTypes, isDark, compactLayout, groupAny, focusTypeId)

      const mermaid = (
        await import(
          /* webpackChunkName: "vendor-mermaid" */
          'mermaid'
        )
      ).default

      const elkLayouts = (
        await import(
          /* webpackChunkName: "vendor-mermaid-elk" */
          '@mermaid-js/layout-elk'
        )
      ).default

      mermaid.registerLayoutLoaders(elkLayouts)

      if (seq !== renderSequence) return

      const themeVariables = getMermaidThemeVariables(isDark)

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'antiscript',
        suppressErrorRendering: true,
        theme: 'base',
        fontFamily: themeVariables.fontFamily,
        fontSize: 13,
        layout: 'elk',
        themeVariables
      })

      const elementId = `mermaid-tt-${Math.random().toString(36).substring(2, 9)}`
      const renderResult = await mermaid.render(elementId, code)

      if (seq !== renderSequence) return

      const customSvgStyles = getCustomSvgStyles(isDark)
      let processedSvg = renderResult.svg
      if (processedSvg.includes('</style>')) {
        processedSvg = processedSvg.replace('</style>', `${customSvgStyles}</style>`)
      }

      const svgBlob = new Blob([processedSvg], { type: 'image/svg+xml;charset=utf-8' })
      const blobUrl = URL.createObjectURL(svgBlob)

      let finalUrl = blobUrl
      try {
        finalUrl = await svgToPng(blobUrl, processedSvg)
      } catch {
        // Fall back to SVG blob URL
      }

      if (seq !== renderSequence) {
        URL.revokeObjectURL(blobUrl)
        return
      }

      revokeObjectUrl()
      if (finalUrl === blobUrl) {
        currentObjectUrl = blobUrl
      } else {
        URL.revokeObjectURL(blobUrl)
      }

      imageUrl = finalUrl
    } catch (e: any) {
      if (seq === renderSequence) {
        console.error('Failed to render task types diagram:', e)
        errorMsg = e?.message ?? 'Failed to render diagram'
      }
    } finally {
      if (seq === renderSequence) {
        loading = false
      }
    }
  }

  $: {
    if (
      taskTypes !== undefined &&
      $languageStore !== undefined &&
      $themeStore !== undefined &&
      compactLayout !== undefined &&
      groupAny !== undefined
    ) {
      void focusTypeId
      void renderDiagram()
    }
  }

  onDestroy(() => {
    revokeObjectUrl()
  })
</script>

<div class="mermaid-wrapper">
  <div class="diagram-top-row">
    {#if hasSelfRefs}
      <div class="diagram-legend">
        <span class="legend-badge">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M3.26794 12.0431C3.7049 13.4662 4.58316 14.7135 5.77571 15.6046C6.96827 16.4957 8.41333 16.9844 9.90195 17.0001C11.6239 17.0213 13.2935 16.4081 14.5924 15.2774C15.8913 14.1467 16.7287 12.5775 16.9449 10.8691C17.1577 9.16057 16.7333 7.4336 15.753 6.01828C14.7727 4.60295 13.3052 3.59854 11.6309 3.19706C9.95636 2.792 8.19129 3.0168 6.6717 3.82869C5.1521 4.64058 3.98408 5.98286 3.38994 7.60006"
              stroke="var(--theme-text-primary, #0f172a)"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              d="M3 4V8H7"
              stroke="var(--theme-text-primary, #0f172a)"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <span class="legend-text font-normal-12">
          <Label label={plugin.string.SelfRefLegend} />
        </span>
      </div>
    {/if}

    <div class="diagram-options">
      {#if hasAnyParents}
        <div class="diagram-option">
          <span class="option-label font-normal-12">
            <Label label={plugin.string.GroupAny} />
          </span>
          <Toggle bind:on={groupAny} />
        </div>
      {/if}

      <div class="diagram-option">
        <span class="option-label font-normal-12">
          <Label label={plugin.string.MergeArrows} />
        </span>
        <Toggle bind:on={compactLayout} />
      </div>
    </div>
  </div>

  <div class="mermaid-center">
    {#if loading}
      <Loading />
    {:else if errorMsg}
      <div class="diagram-error-state">
        <div class="diagram-error-icon">
          <IconError size="large" />
        </div>
        <div class="diagram-error-title">
          <Label label={plugin.string.TaskTypesDiagram} />
        </div>
        <div class="diagram-error-actions">
          <Button kind="ghost" size="small" on:click={() => (showDetails = !showDetails)}>
            <Label label={showDetails ? plugin.string.HideDetails : plugin.string.ShowDetails} />
          </Button>
        </div>
        {#if showDetails}
          <div class="diagram-error-details">
            <code>{errorMsg}</code>
          </div>
        {/if}
      </div>
    {:else if imageUrl}
      <img src={imageUrl} alt="Task Types Hierarchy Diagram" class="mermaid-image" />
    {/if}
  </div>
</div>

<style lang="scss">
  .mermaid-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 1rem;
    overflow: auto;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }

  .diagram-top-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  .diagram-legend {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    border-radius: var(--small-BorderRadius, 0.375rem);
    background: var(--global-surface-02-BackgroundColor, rgba(0, 0, 0, 0.03));
    border: 1px solid var(--theme-border-color, rgba(255, 255, 255, 0.08));

    .legend-badge {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .legend-text {
      color: var(--theme-text-secondary, #64748b);
      line-height: 1;
    }
  }

  .diagram-options {
    display: inline-flex;
    align-items: center;
    gap: 1rem;
    margin-left: auto;
    flex-wrap: wrap;
  }

  .diagram-option {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;

    .option-label {
      color: var(--theme-text-secondary, #64748b);
      line-height: 1;
    }
  }

  .mermaid-center {
    flex: 1;
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    overflow: auto;
  }

  .mermaid-image {
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    display: block;
    margin: auto;
  }

  .diagram-error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    text-align: center;
    max-width: 24rem;
    box-sizing: border-box;

    .diagram-error-icon {
      color: var(--negative-button-default, #f44336);
      margin-bottom: 0.5rem;
    }

    .diagram-error-title {
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--theme-text-primary, #f8fafc);
      margin-bottom: 0.25rem;
    }

    .diagram-error-actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.5rem;
    }

    .diagram-error-details {
      margin-top: 0.75rem;
      width: 100%;
      max-height: 10rem;
      overflow-y: auto;
      background: var(--theme-surface-tertiary, rgba(0, 0, 0, 0.2));
      border: 1px solid var(--theme-border-color, rgba(255, 255, 255, 0.08));
      border-radius: 0.375rem;
      padding: 0.5rem 0.75rem;
      text-align: left;
      box-sizing: border-box;

      code {
        font-family: var(--font-family-mono, monospace);
        font-size: 0.75rem;
        color: var(--negative-button-default, #f44336);
        white-space: pre-wrap;
        word-break: break-word;
      }
    }
  }
</style>
