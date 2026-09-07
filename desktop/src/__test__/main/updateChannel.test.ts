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

import * as fs from 'fs'
import * as path from 'path'
import {
  DEFAULT_UPDATES_CHANNEL,
  DEFAULT_UPDATES_URL,
  channelManifests,
  parseUpdateChannels,
  resolveUpdateFeed
} from '../../main/updateChannel'

describe('parseUpdateChannels', () => {
  it('reads a bare default channel', () => {
    expect(parseUpdateChannels('latest')).toEqual({ default: 'latest' })
  })

  it('reads a default plus per-key overrides', () => {
    expect(parseUpdateChannels('dev;tracex:dev-tracex')).toEqual({ default: 'dev', tracex: 'dev-tracex' })
  })

  it('tolerates whitespace and empty entries', () => {
    expect(parseUpdateChannels(' dev ; ; tracex : dev-tracex ')).toEqual({
      default: 'dev',
      tracex: 'dev-tracex'
    })
  })

  it('ignores malformed entries instead of producing a bogus channel', () => {
    expect(parseUpdateChannels('a:b:c')).toEqual({})
  })
})

describe('resolveUpdateFeed', () => {
  it('falls back to a channel the server actually publishes', () => {
    // An unpublished channel means every update check 404s, silently.
    expect(resolveUpdateFeed({}, {})).toEqual({
      url: DEFAULT_UPDATES_URL,
      channel: DEFAULT_UPDATES_CHANNEL
    })
  })

  it('prefers env over config', () => {
    const feed = resolveUpdateFeed(
      { DESKTOP_UPDATES_URL: 'https://config.example/_dist', DESKTOP_UPDATES_CHANNELS: 'from-config' },
      { DESKTOP_UPDATES_URL: 'https://env.example/_dist', DESKTOP_UPDATES_CHANNEL: 'from-env' }
    )
    expect(feed).toEqual({ url: 'https://env.example/_dist', channel: 'from-env' })
  })

  it('honours DESKTOP_UPDATES_CHANNELS from env, not just from config', () => {
    const config = { DESKTOP_UPDATES_CHANNELS: 'from-config' }
    expect(resolveUpdateFeed(config, { DESKTOP_UPDATES_CHANNELS: 'dev;tracex:dev-tracex' }, 'tracex').channel).toBe(
      'dev-tracex'
    )
  })

  it('prefers the plural env key over the singular one', () => {
    const feed = resolveUpdateFeed({}, { DESKTOP_UPDATES_CHANNELS: 'plural', DESKTOP_UPDATES_CHANNEL: 'singular' })
    expect(feed.channel).toBe('plural')
  })

  it('prefers DESKTOP_UPDATES_CHANNELS over the deprecated singular key', () => {
    const feed = resolveUpdateFeed({ DESKTOP_UPDATES_CHANNELS: 'new', DESKTOP_UPDATES_CHANNEL: 'old' }, {})
    expect(feed.channel).toBe('new')
  })

  it('still honours the deprecated singular key alone', () => {
    expect(resolveUpdateFeed({ DESKTOP_UPDATES_CHANNEL: 'old' }, {}).channel).toBe('old')
  })

  it('selects the channel for the packed config key', () => {
    const config = { DESKTOP_UPDATES_CHANNELS: 'dev;tracex:dev-tracex' }
    expect(resolveUpdateFeed(config, {}, 'tracex').channel).toBe('dev-tracex')
    expect(resolveUpdateFeed(config, {}, 'unknown').channel).toBe('dev')
    expect(resolveUpdateFeed(config, {}).channel).toBe('dev')
  })
})

describe('published channels', () => {
  // A config pointing at a channel the publish script never produces means that
  // deployment gets no updates at all.
  const publishScript = fs.readFileSync(
    path.join(__dirname, '../../../../desktop-package/scripts/copy-publish-artifacts.sh'),
    'utf8'
  )
  const publishedChannel = /^CHANNEL=(\S+)$/m.exec(publishScript)?.[1]

  it('publish script ships the default channel', () => {
    expect(publishedChannel).toBe(DEFAULT_UPDATES_CHANNEL)
  })

  it('publish script ships every manifest electron-updater asks for', () => {
    for (const manifest of channelManifests(DEFAULT_UPDATES_CHANNEL)) {
      const suffix = manifest.replace(DEFAULT_UPDATES_CHANNEL, '$CHANNEL')
      expect(publishScript).toContain(suffix.replace('.yml', ''))
    }
  })
})
