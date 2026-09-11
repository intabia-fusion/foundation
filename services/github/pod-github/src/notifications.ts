import { Doc, Ref, TxOperations, AccountUuid } from '@hcengineering/core'
import notification from '@hcengineering/notification'
import { IntlString } from '@hcengineering/platform'
import { PersonSpace } from '@hcengineering/contact'
import github from '@hcengineering/github'

function isSameProps (props1: Record<string, any>, props2: Record<string, any>): boolean {
  return (
    Object.keys(props1).length === Object.keys(props2).length &&
    Object.keys(props1).every((key) => props1[key] === props2[key])
  )
}

export async function createNotification (
  client: TxOperations,
  forDoc: Doc,
  data: { user: AccountUuid, space: Ref<PersonSpace>, message: IntlString, props: Record<string, any> }
): Promise<void> {
  const context = await client.findOne(notification.class.DocNotifyContext, { objectId: forDoc._id, user: data.user })

  // Check if we had already same notification send, and just unmark it viewed.
  const existing = context?.latestNotifications.find(
    (it) => it.type === 'common' && it.messageIntl === data.message && isSameProps(it.intlParams ?? {}, data.props)
  )

  if (existing !== undefined) {
    return
  }

  await client.createDoc(notification.class.CreateNotificationAction, data.space, {
    attachedTo: forDoc._id,
    attachedToClass: forDoc._class,
    account: data.user,
    notification: {
      icon: github.icon.Github,
      messageIntl: data.message
    },
    intl: {
      intlParams: data.props
    }
  })
}
