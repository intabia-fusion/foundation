import core from '@hcengineering/core'
import { formatName } from '@hcengineering/contact'

import { Sender } from './index'

export function truncateMessage (message: string, maxLength = 300): string {
  const trimmed = message.trim()
  if (trimmed.length > maxLength) return trimmed.slice(0, maxLength) + '...'
  return trimmed
}

export function getSenderName (sender: Sender, lastNameFirst?: string): string {
  if (sender.socialId === core.account.System || sender.socialId === core.account.ConfigUser) {
    return 'System'
  }

  const { person } = sender

  if (person === undefined) {
    console.error('Cannot find person', { socialId: sender.socialId })

    return 'Unknown user'
  }

  return formatName(person.name, lastNameFirst ?? 'false')
}
