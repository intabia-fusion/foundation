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
  import core, { Status, StatusCategory } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import task from '@hcengineering/task'
  import {
    Button,
    ButtonIcon,
    getColorNumberByText,
    getPlatformColorDef,
    IconError,
    IconSquareExpand,
    Label,
    languageStore,
    Loading,
    showPopup,
    themeStore
  } from '@hcengineering/ui'
  import { Workflow, WorkflowTransition } from '@hcengineering/workflow'

  import plugin from '../../plugin'
  import WorkflowDiagramPopup from './WorkflowDiagramPopup.svelte'

  export let workflow: Workflow
  export let statuses: Status[] = []
  export let transitions: WorkflowTransition[] = []
  export let embedded = false

  const defaultCategoryColors: Record<string, number> = {
    [task.statusCategory.UnStarted]: 21,
    [task.statusCategory.ToDo]: 23,
    [task.statusCategory.Active]: 11,
    [task.statusCategory.Won]: 17,
    [task.statusCategory.Lost]: 22
  }

  let imageUrl: string | undefined = undefined
  let errorMsg: string | undefined = undefined
  let showDetails = false
  let loading = true
  let currentObjectUrl: string | undefined = undefined
  let renderSequence = 0

  function sanitizeLabel (str: string): string {
    if (!str) return ''
    return str
      .replace(/"/g, '#quot;')
      .replace(/[\r\n]+/g, ' ')
      .trim()
  }

  function sanitizeColor (color: string | undefined, fallback: string): string {
    if (!color) return fallback
    const trimmed = color.trim()
    if (trimmed.includes('gradient') || trimmed.includes('(') || trimmed.includes(',')) {
      const match = trimmed.match(/#(?:[0-9a-fA-F]{3,8})/)
      if (match) return match[0]
      return fallback
    }
    return trimmed
  }

  function generateMermaidCode (
    statuses: Status[],
    transitions: WorkflowTransition[],
    initialStatuses: string[] = [],
    isDark: boolean
  ): string {
    const statusNodeIds = new Map<string, string>()
    statuses.forEach((s, idx) => statusNodeIds.set(s._id, `st_${idx}`))

    const client = getClient()
    const categories = client.getModel().findAllSync<StatusCategory>(core.class.StatusCategory, {})
    const categoryMap = new Map(categories.map((c) => [c._id, c]))

    const lines: string[] = ['---', 'config:', '  theme: redux', '---', 'flowchart TB']

    // Status nodes with platform background/foreground colors
    for (const s of statuses) {
      const nodeId = statusNodeIds.get(s._id)
      if (!nodeId) continue

      const label = sanitizeLabel(s.name)
      lines.push(`  ${nodeId}(["${label}"])`)

      const category = s.category ? categoryMap.get(s.category) : undefined
      const colorNum =
        s.color !== undefined && typeof s.color !== 'string'
          ? s.color
          : (category?.color ??
            (s.category ? defaultCategoryColors[s.category] : undefined) ??
            getColorNumberByText(s.name))
      const colorDef = getPlatformColorDef(colorNum, isDark)

      const fill = sanitizeColor(colorDef.background, isDark ? '#1e293b' : '#f1f5f9')
      const textColor = sanitizeColor(colorDef.color, isDark ? '#f8fafc' : '#0f172a')
      const stroke = sanitizeColor(colorDef.title, isDark ? '#475569' : '#64748b')

      lines.push(`  style ${nodeId} fill:${fill},color:${textColor},stroke:${stroke}`)
    }

    // Initial status entry points
    const effectiveInitialStatuses =
      initialStatuses.length === 0 || initialStatuses.includes('null') ? statuses.map((s) => s._id) : initialStatuses

    if (effectiveInitialStatuses.length > 0) {
      lines.push('  init[" "]')
      lines.push('  init@{ shape: sm-circ}')
      const initStyle = isDark
        ? 'fill:none,stroke:#94a3b8,stroke-width:2px'
        : 'fill:none,stroke:#242538,stroke-width:2px'
      lines.push(`  style init ${initStyle}`)

      for (const initId of effectiveInitialStatuses) {
        const targetNode = statusNodeIds.get(initId)
        if (targetNode) {
          lines.push(`  init --> ${targetNode}`)
        }
      }
    }

    // Transitions between statuses
    let anyCount = 0
    for (const t of transitions) {
      const toNode = statusNodeIds.get(t.to)
      if (!toNode) continue

      if (t.from === null || t.from === undefined || t.from.length === 0) {
        const anyNodeId = `any_${anyCount++}`
        lines.push(`  ${anyNodeId}(["any"])`)
        const anyStyle = isDark
          ? 'fill:none,color:#cbd5e1,stroke:#94a3b8,stroke-width:1px,font-size:8px'
          : 'fill:none,color:#1e293b,stroke:#242538,stroke-width:1px,font-size:8px'
        lines.push(`  style ${anyNodeId} ${anyStyle}`)
        lines.push(`  ${anyNodeId} --> ${toNode}`)
      } else {
        for (const fromId of t.from) {
          const fromNode = statusNodeIds.get(fromId)
          if (fromNode) {
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
    const textColor = isDark ? '#cbd5e1' : '#1e293b'

    return `
      g.node[id*="init"] circle, g.node[id*="init"] path, [id*="init"] circle {
        fill: none !important;
        fill-opacity: 0 !important;
        stroke: ${strokeColor} !important;
        stroke-width: 2px !important;
      }
      g.node[id*="any"] rect, g.node[id*="any"] path, [id*="any"] path, [id*="any"] polygon {
        fill: none !important;
        fill-opacity: 0 !important;
        stroke: ${strokeColor} !important;
        stroke-width: 1px !important;
      }
      g.node[id*="any"] text, [id*="any"] text {
        fill: ${textColor} !important;
        color: ${textColor} !important;
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

    if (!statuses || statuses.length === 0) {
      loading = false
      imageUrl = undefined
      return
    }

    try {
      const isDark = $themeStore.dark
      const code = generateMermaidCode(statuses, transitions, workflow?.initialStatuses, isDark)

      const mermaid = (
        await import(
          /* webpackChunkName: "vendor-mermaid" */
          'mermaid'
        )
      ).default

      if (seq !== renderSequence) return

      const themeVariables = getMermaidThemeVariables(isDark)
      const fontFamily = themeVariables.fontFamily

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'antiscript',
        suppressErrorRendering: true,
        theme: 'base',
        fontFamily,
        fontSize: 13,
        themeVariables
      })

      const elementId = `mermaid-wf-${Math.random().toString(36).substring(2, 9)}`
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
        // Fall back to SVG blob URL if PNG rasterization fails
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
        console.error('Failed to render workflow diagram:', e)
        errorMsg = e?.message ?? 'Failed to render diagram'
      }
    } finally {
      if (seq === renderSequence) {
        loading = false
      }
    }
  }

  function handleShowPopup (): void {
    if (workflow === undefined) return
    showPopup(WorkflowDiagramPopup, { workflow, statuses, transitions, fullSize: true }, 'centered')
  }

  $: {
    const _lang = $languageStore
    const _theme = $themeStore
    if (
      workflow !== undefined &&
      statuses !== undefined &&
      transitions !== undefined &&
      _lang !== undefined &&
      _theme !== undefined
    ) {
      void renderDiagram()
    }
  }

  onDestroy(() => {
    revokeObjectUrl()
  })
</script>

<div class="mermaid-wrapper" class:embedded>
  {#if embedded && imageUrl}
    <div class="mermaid-controls">
      <ButtonIcon
        icon={IconSquareExpand}
        tooltip={{ label: plugin.string.Transitions, direction: 'bottom' }}
        size="small"
        kind="secondary"
        on:click={handleShowPopup}
      />
    </div>
  {/if}
  <div class="mermaid-center">
    {#if loading}
      <Loading />
    {:else if errorMsg}
      <div class="diagram-error-state">
        <div class="diagram-error-icon">
          <IconError size="large" />
        </div>
        <div class="diagram-error-title">
          <Label label={plugin.string.FailedToRenderDiagram ?? 'Не удалось отобразить схему воркфлоу'} />
        </div>
        <div class="diagram-error-hint">
          <Label label={plugin.string.DiagramErrorHint ?? 'Произошла ошибка при генерации схемы переходов.'} />
        </div>
        <div class="diagram-error-actions">
          <Button kind="ghost" size="small" on:click={() => (showDetails = !showDetails)}>
            <Label
              label={showDetails
                ? (plugin.string.HideDetails ?? 'Скрыть подробности')
                : (plugin.string.ShowDetails ?? 'Показать подробности')}
            />
          </Button>
        </div>
        {#if showDetails}
          <div class="diagram-error-details">
            <code>{errorMsg}</code>
          </div>
        {/if}
      </div>
    {:else if imageUrl}
      <img src={imageUrl} alt="Workflow Transitions Diagram" class="mermaid-image" />
    {/if}
  </div>
</div>

<style lang="scss">
  .mermaid-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
    padding: 0.75rem;
    overflow: hidden;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;

    &.embedded {
      height: 100%;
      min-height: 0;
      background: var(--theme-surface-secondary, rgba(0, 0, 0, 0.02));
      border-radius: var(--small-BorderRadius, 0.5rem);
      border: 0.0625rem solid var(--theme-border-color, rgba(255, 255, 255, 0.08));
    }
  }

  .mermaid-controls {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    z-index: 5;
  }

  .mermaid-center {
    flex: 1;
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    overflow: hidden;
  }

  .mermaid-image {
    max-width: 100%;
    max-height: 100%;
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
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
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .diagram-error-title {
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--theme-text-primary, #f8fafc);
      margin-bottom: 0.25rem;
    }

    .diagram-error-hint {
      font-size: 0.8125rem;
      color: var(--theme-text-secondary, #94a3b8);
      line-height: 1.35;
      margin-bottom: 0.75rem;
    }

    .diagram-error-actions {
      display: flex;
      gap: 0.5rem;
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
