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

// The queue consumer's side of the send: handleSendMail puts a message on NotificationQueue, this
// turns it back into a mail. Both the HTTP path and queue producers can name their own sender.
jest.mock('../config', () => {
  return {
    __esModule: true,
    default: {
      source: 'platform@intabia.ru',
      replyTo: 'support@intabia.ru',
      mode: 'queue',
      port: 1025,
      apiKey: 'test-key'
    }
  }
})

jest.mock('../mail', () => {
  return {
    __esModule: true,
    MailClient: jest.fn().mockImplementation(() => ({ sendMessage: jest.fn() }))
  }
})

describe('createEmailMessage', () => {
  let createEmailMessage: any

  beforeEach(async () => {
    createEmailMessage = (await import('../main')).createEmailMessage
  })

  const notification = (over: Record<string, any> = {}): any => ({
    to: 'payer@example.com',
    subject: 'Чек об оплате',
    text: 'plain',
    html: '<p>html</p>',
    ...over
  })

  test('a sender chosen by the producer survives', async () => {
    // handleSendMail resolves `from` before enqueuing, so overwriting it here dropped MAIL_FROM
    // on the HTTP path as well.
    const msg = createEmailMessage(notification({ from: 'billing@intabia.ru' }))
    expect(msg.from).toBe('billing@intabia.ru')
  })

  test('no sender given -> the configured source', async () => {
    const msg = createEmailMessage(notification())
    expect(msg.from).toBe('platform@intabia.ru')
  })

  test('reply-to is applied when the sender is the configured source', async () => {
    const msg = createEmailMessage(notification({ from: 'platform@intabia.ru' }))
    expect(msg.replyTo).toBe('support@intabia.ru')
  })

  test('a custom sender keeps its own reply-to behaviour (none forced)', async () => {
    const msg = createEmailMessage(notification({ from: 'billing@intabia.ru' }))
    expect(msg.replyTo).toBeUndefined()
  })

  test('the payload is passed through untouched', async () => {
    const msg = createEmailMessage(notification())
    expect(msg.to).toBe('payer@example.com')
    expect(msg.subject).toBe('Чек об оплате')
    expect(msg.text).toBe('plain')
    expect(msg.html).toBe('<p>html</p>')
  })
})
