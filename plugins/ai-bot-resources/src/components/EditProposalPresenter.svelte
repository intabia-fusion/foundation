<!--
// Copyright © 2026 Intabia Fusion
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
  import { type AIEditProposalMessage } from '@hcengineering/ai-bot'
  import { getClient } from '@hcengineering/presentation'
  import { markupToJSON, type MarkupNode } from '@hcengineering/text'
  import { Button, Label, showPanel } from '@hcengineering/ui'
  import { getRegisteredEditor, MarkupDiffViewer } from '@hcengineering/text-editor-resources'
  import view from '@hcengineering/view'
  import { onMount } from 'svelte'

  import plugin from '../plugin'

  export let value: AIEditProposalMessage

  const client = getClient()
  const hierarchy = client.getHierarchy()

  // Show the proposal expanded by default until it is applied, so the user sees what the model
  // suggests without clicking. Collapsed once applied.
  let showDiff = value.applied !== true
  let baseNode: MarkupNode | undefined

  $: proposedNode = markupToJSON(value.proposedMarkup)

  function editorFor (): ReturnType<typeof getRegisteredEditor> {
    return getRegisteredEditor(value.targetId, value.targetAttr)
  }

  // The registry is not reactive; re-read on each interaction (and at mount) rather than watch.
  $: editorOpen = editorFor() !== undefined

  // Base for the diff: current document text when open, otherwise the proposal itself (shows the
  // proposed content with no decorations). Recomputed when toggling so an opened doc gives a real diff.
  function computeBase (): void {
    const ed = editorFor()
    baseNode = ed !== undefined ? (ed.getJSON() as MarkupNode) : proposedNode
  }

  onMount(() => {
    if (showDiff) computeBase()
  })

  function toggleDiff (): void {
    if (!showDiff) computeBase()
    showDiff = !showDiff
  }

  async function apply (): Promise<void> {
    const ed = editorFor()
    if (ed === undefined) return
    ed.commands.setContent(proposedNode as any)
    await client.updateDoc(value._class, value.space, value._id, { applied: true } as any)
  }

  function openDocument (): void {
    const panelMixin = hierarchy.classHierarchyMixin(value.targetClass, view.mixin.ObjectPanel)
    const component = panelMixin?.component ?? view.component.EditDoc
    showPanel(component, value.targetId, value.targetClass, 'content')
  }
</script>

<div class="proposal">
  <div class="label"><Label label={plugin.string.ProposedEdit} /></div>

  {#if showDiff}
    <div class="diff">
      <!-- content = proposed (rendered base), comparedVersion = current: added shows green,
           removed shows struck-through red — i.e. old -> new, not new -> old. -->
      <MarkupDiffViewer content={proposedNode} comparedVersion={baseNode} objectClass={value.targetClass} />
    </div>
  {/if}

  <div class="actions">
    <Button
      label={showDiff ? plugin.string.HideDiff : plugin.string.PreviewDiff}
      kind={'ghost'}
      on:click={toggleDiff}
    />
    {#if value.applied === true}
      <Button label={plugin.string.EditApplied} kind={'ghost'} disabled />
    {:else if editorOpen}
      <Button label={plugin.string.ApplyEdit} kind={'primary'} on:click={apply} />
    {:else}
      <Button label={plugin.string.OpenDocument} kind={'primary'} on:click={openDocument} />
    {/if}
  </div>
</div>

<style lang="scss">
  .proposal {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.5rem;
  }
  .label {
    font-weight: 500;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .diff {
    max-height: 20rem;
    overflow: auto;
  }
</style>
