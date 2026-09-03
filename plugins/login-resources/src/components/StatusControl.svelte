<!--
// Copyright © 2020 Anticrm Platform Contributors.
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
  import type { Status } from '@hcengineering/platform'
  import { Severity } from '@hcengineering/platform'
  import { IconInfo, Label } from '@hcengineering/ui'

  // import { Status as StatusControl } from '@hcengineering/ui'

  export let status: Status
  // Validation messages wrap onto several lines instead of being ellipsised.
  export let overflow: boolean = false
</script>

{#if status.severity !== Severity.OK}
  <div class="flex-row-center container {status.severity}" class:error={status.severity === Severity.ERROR}>
    <!-- <StatusControl {status} overflow={false} /> -->
    <IconInfo size={'small'} />
    <span class="text-sm ml-2 message" class:overflow-label={overflow}>
      <Label label={status.code} params={status.params} />
    </span>
  </div>
{/if}

<style lang="scss">
  .container {
    align-items: flex-start;
    user-select: none;
    font-size: 14px;
    padding: 0.75rem 1rem;
    background-color: var(--login-button-default, var(--theme-button-default));
    border: 1px solid var(--login-button-border, var(--theme-button-border));
    border-radius: 0.5rem;
    /* Ensure status text is readable inside the white login card by preferring
       login-scoped content color (falls back to global theme token). */
    color: var(--login-content-color, var(--theme-content-color));
    fill: var(--login-content-color, var(--theme-content-color));
    &.WARNING {
      color: yellow;
    }
    &.ERROR {
      color: var(--system-error-color);
    }
  }

  .container :global(svg) {
    flex-shrink: 0;
    margin-top: 0.125rem;
  }

  .message {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .error {
    color: var(--system-error-color);
    fill: var(--system-error-color);
    background-color: var(--login-button-default, var(--theme-button-default));
    border-color: var(--system-error-60-color);
  }
</style>
