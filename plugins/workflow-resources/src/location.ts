//
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

import { type Ref } from '@hcengineering/core'
import { desktopPlatform, getCurrentResolvedLocation, locationToUrl, navigate } from '@hcengineering/ui'
import { type Workflow, type Screen } from '@hcengineering/workflow'
import { type Project, type TaskType } from '@hcengineering/task'
import { clearSettingsStore } from '@hcengineering/setting-resources'

export function navigateToProject (project: Project, openInNewTab = false): void {
  const loc = getCurrentResolvedLocation()
  loc.path[2] = 'tracker'
  loc.path[3] = project._id
  loc.path[4] = 'issues'
  loc.path.length = 5

  if (!desktopPlatform && openInNewTab) {
    window.open(locationToUrl(loc), '_blank')
  } else {
    clearSettingsStore()
    navigate(loc)
  }
}

export function navigateToWorkflow (id: Ref<Workflow> | undefined, openInNewTab = false): void {
  const loc = getCurrentResolvedLocation()
  if (id !== undefined) {
    loc.path[5] = 'workflows'
    loc.path[6] = id
    loc.path.length = 7
  } else {
    loc.path.length = 5
  }

  if (!desktopPlatform && openInNewTab && id !== undefined) {
    window.open(locationToUrl(loc), '_blank')
  } else {
    clearSettingsStore()
    navigate(loc)
  }
}

export function navigateToScreen (id: Ref<Screen> | undefined, openInNewTab = true): void {
  const loc = getCurrentResolvedLocation()
  if (id !== undefined) {
    loc.path[5] = 'screens'
    loc.path[6] = id
    loc.path.length = 7
  } else {
    loc.path.length = 5
  }

  if (!desktopPlatform && openInNewTab && id !== undefined) {
    window.open(locationToUrl(loc), '_blank')
  } else {
    clearSettingsStore()
    navigate(loc)
  }
}

export function navigateToTaskType (id: Ref<TaskType> | undefined, openInNewTab = true): void {
  const loc = getCurrentResolvedLocation()
  if (id !== undefined) {
    loc.path[5] = 'taskTypes'
    loc.path[6] = id
    loc.path.length = 7
  } else {
    loc.path.length = 5
  }

  if (!desktopPlatform && openInNewTab && id !== undefined) {
    window.open(locationToUrl(loc), '_blank')
  } else {
    clearSettingsStore()
    navigate(loc)
  }
}

export function navigateToTaskTypes (openInNewTab = true, fragment = 'taskTypes'): void {
  const loc = getCurrentResolvedLocation()
  loc.path.length = 5
  if (fragment !== undefined) {
    loc.fragment = fragment
  }

  if (!desktopPlatform && openInNewTab) {
    window.open(locationToUrl(loc), '_blank')
  } else {
    clearSettingsStore()
    navigate(loc)
  }
}
