//
// Copyright © 2024 Hardcore Engineering Inc.
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

import serverCore from '@hcengineering/server-core'
import type { StringPresenterFn, PresenterControl } from '@hcengineering/server-activity'
import training, { trainingId, TrainingRequest } from '@hcengineering/training'
import { getMetadata } from '@hcengineering/platform'
import { workbenchId } from '@hcengineering/workbench'
import { concatLink } from '@hcengineering/core'

export const TrainingRequestTitlePresenter: StringPresenterFn<TrainingRequest> = async (
  request: TrainingRequest,
  control: PresenterControl
) => {
  const trainingObject = (await control.findAll(control.ctx, training.class.Training, { _id: request.attachedTo }))[0]

  if (trainingObject === undefined) {
    throw new Error(`Training #${request.attachedTo} not found`)
  }

  return `${trainingObject.code} • ${trainingObject.title} • Revision ${trainingObject.revision}`
}

export const TrainingRequestUrlPresenter: StringPresenterFn<TrainingRequest> = async (
  request: TrainingRequest,
  control: PresenterControl
) => {
  const front = control.branding?.front ?? getMetadata(serverCore.metadata.FrontUrl) ?? ''
  // TODO: Don't hardcode URLs, find a way to share routes info between front and server resources, and DRY
  const path = `${workbenchId}/${control.workspace.url}/${trainingId}/requests/${request._id}`
  return concatLink(front, path)
}
