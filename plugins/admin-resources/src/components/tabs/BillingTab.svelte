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
  import { Tabs } from '@hcengineering/ui'
  import type { AnySvelteComponent, TabModel } from '@hcengineering/ui'
  import billingPlugin from '@hcengineering/billing'
  import { ModelsTab, ClientsTab, CalculatorTab } from '@hcengineering/billing-resources'

  let selected = 0

  const tabModel: TabModel = [
    { label: billingPlugin.string.TabModels, component: ModelsTab as AnySvelteComponent, props: {} },
    { label: billingPlugin.string.TabUsage, component: ClientsTab as AnySvelteComponent, props: {} },
    { label: billingPlugin.string.TabCalculator, component: CalculatorTab as AnySvelteComponent, props: {} }
  ]
</script>

<div class="flex-col h-full p-4">
  <Tabs model={tabModel} bind:selected />
</div>
