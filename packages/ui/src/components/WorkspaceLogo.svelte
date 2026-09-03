<!--
// Copyright © 2026 Intabia Fusion.
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
  export let mini: boolean = false
  export let name: string
  export let accent = false
  export let notify = false
  export let logoUrl: string | undefined = undefined
  export let logoSrcset: string | undefined = undefined
</script>

<div class="logo" class:mini>
  {#if logoUrl != null}
    <img class="logo-medium" src={logoUrl} srcset={logoSrcset} alt={''} />
  {:else}
    <div class="antiLogo" class:mini class:accent>{name.toUpperCase()?.[0] ?? ''}</div>
  {/if}
  {#if notify}
    <span class="notification" />
  {/if}
</div>

<style lang="scss">
  .logo {
    position: relative;
  }

  .antiLogo {
    display: flex;
    justify-content: center;
    align-items: center;
    flex-shrink: 0;
    font-weight: 500;
    border-radius: 0.25rem;
    outline: none;
    cursor: pointer;
    background-color: var(--avatar-bg-color);
    color: var(--theme-accent-color);

    &:hover {
      opacity: 0.8;
    }
    &:not(.mini) {
      width: 2rem;
      height: 2rem;
    }
    &.mini {
      width: 1.75rem;
      height: 1.75rem;
    }
    &.accent {
      background-color: rgb(246, 105, 77);
      color: var(--primary-button-color);
    }
  }

  .logo-medium {
    outline: none;
    cursor: pointer;
    width: 2rem;
    height: 2rem;
    border-radius: 0.25rem;
  }

  .notification {
    position: absolute;
    top: -0.5rem;
    right: -0.375rem;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background-color: var(--global-higlight-Color);
  }

  .logo.mini .notification {
    top: -0.35rem;
    right: -0.15rem;
  }
</style>
