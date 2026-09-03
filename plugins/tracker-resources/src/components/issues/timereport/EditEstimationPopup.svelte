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
//
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import presentation, { Card } from '@hcengineering/presentation'
  import { createEventDispatcher } from 'svelte'
  import tracker from '../../../plugin'
  import DurationInput from './DurationInput.svelte'

  export let value: number = 0

  const dispatch = createEventDispatcher()
  let hours: number | undefined = value > 0 ? value : undefined

  $: canSave = hours !== undefined

  function save (): void {
    dispatch('close', hours)
  }

  function cancel (): void {
    dispatch('close', null)
  }
</script>

<Card
  label={tracker.string.Estimation}
  {canSave}
  okAction={save}
  okLabel={presentation.string.Save}
  gap={'gapV-4'}
  on:close={cancel}
>
  <DurationInput bind:hours />
</Card>
