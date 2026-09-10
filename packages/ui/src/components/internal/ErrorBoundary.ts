//
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
//

import ErrorComponent from './ErrorComponent.svelte'
class ErrorBoundary extends ErrorComponent {
  constructor (config: any) {
    let error: any = null
    config.props.$$slots.default = config.props.$$slots.default.map((x: any) => (...args: any[]) => {
      try {
        return x(...args)
      } catch (e) {
        console.error(e)
        error = e
      }
    })
    super(config)
    if (error != null) {
      this.$set({ error })
    }
  }
}

// TS 6 no longer keeps the svelte component shape across the subclass, so hand the base
// component's constructor type back to callers.
export default ErrorBoundary as unknown as typeof ErrorComponent
