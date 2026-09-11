import type { Plugin, Resource } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'
import { TriggerFunc } from '@hcengineering/server-core'
import { StringPresenterFn } from '@hcengineering/server-activity'

/**
 * @public
 */
export const serverLoveId = 'server-love' as Plugin

/**
 * @public
 */
export default plugin(serverLoveId, {
  function: {
    MeetingMinutesUrlPresenter: '' as Resource<StringPresenterFn>
  },
  trigger: {
    OnEmployee: '' as Resource<TriggerFunc>,
    OnUserStatus: '' as Resource<TriggerFunc>,
    OnParticipantInfo: '' as Resource<TriggerFunc>,
    OnRoomInfo: '' as Resource<TriggerFunc>,
    OnKnock: '' as Resource<TriggerFunc>,
    OnUserMeetingInvite: '' as Resource<TriggerFunc>,
    OnEventUpdate: '' as Resource<TriggerFunc>
  }
})
