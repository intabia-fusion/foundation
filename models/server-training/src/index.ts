//
// Copyright @ 2022 Hardcore Engineering Inc.
//
import { type Builder } from '@hcengineering/model'

import training from '@hcengineering/model-training'
import serverTraining from '@hcengineering/server-training'
import core from '@hcengineering/core'
import notification from '@hcengineering/notification'
import serverNotification from '@hcengineering/server-notification'
import serverActivity from '@hcengineering/server-activity'

export { serverTrainingId } from '@hcengineering/server-training/src/index'

export function createModel (builder: Builder): void {
  builder.mixin(
    training.notification.TrainingRequest,
    notification.class.NotificationType,
    serverNotification.mixin.TypeMatch,
    {
      match: serverTraining.function.TrainingRequestNotificationTypeMatch
    }
  )

  builder.mixin(training.class.TrainingRequest, core.class.Class, serverActivity.mixin.TitlePresenter, {
    presenter: serverTraining.function.TrainingRequestTitlePresenter,
    triggerFields: ['title', 'name']
  })

  builder.mixin(training.class.TrainingRequest, core.class.Class, serverActivity.mixin.UrlPresenter, {
    presenter: serverTraining.function.TrainingRequestUrlPresenter
  })
}
