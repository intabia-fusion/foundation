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

export const DEFAULT_UPDATES_URL = 'https://platform.intabia.ru/_dist'

// electron-builder publishes `latest.yml` / `latest-mac.yml` / `latest-linux*.yml`,
// so this is the only channel the distribution server is guaranteed to have.
export const DEFAULT_UPDATES_CHANNEL = 'latest'

export interface UpdateChannelConfig {
  DESKTOP_UPDATES_URL?: string
  DESKTOP_UPDATES_CHANNEL?: string
  DESKTOP_UPDATES_CHANNELS?: string
}

export interface UpdateFeed {
  url: string
  channel: string
}

/**
 * Parse the channel map. Format: `default_channel;key1:channel1;key2:channel2`.
 * A bare entry sets the default; `key:value` entries map a packed-config key.
 */
export function parseUpdateChannels (spec: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const entry of spec.split(';')) {
    const parts = entry.split(':').map((p) => p.trim())
    if (parts.length === 1) {
      if (parts[0] !== '') map.default = parts[0]
    } else if (parts.length === 2) {
      const [key, value] = parts
      if (key !== '' && value !== '') map[key] = value
    }
  }
  return map
}

/**
 * Resolve the generic-provider feed the auto updater should poll.
 * Precedence: process env, then combined config, then the built-in default.
 */
export function resolveUpdateFeed (
  config: UpdateChannelConfig,
  env: Record<string, string | undefined>,
  channelKey?: string
): UpdateFeed {
  const url = env.DESKTOP_UPDATES_URL ?? config.DESKTOP_UPDATES_URL ?? DEFAULT_UPDATES_URL
  const spec =
    env.DESKTOP_UPDATES_CHANNELS ??
    env.DESKTOP_UPDATES_CHANNEL ??
    config.DESKTOP_UPDATES_CHANNELS ??
    config.DESKTOP_UPDATES_CHANNEL ??
    ''
  const channels = parseUpdateChannels(spec)
  const key = channelKey ?? 'default'
  const channel = channels[key] ?? channels.default ?? DEFAULT_UPDATES_CHANNEL
  return { url, channel }
}

/**
 * Manifest files electron-updater will request for a channel. Useful to assert a
 * channel is actually published before shipping a config that points at it.
 */
export function channelManifests (channel: string): string[] {
  return [`${channel}.yml`, `${channel}-mac.yml`, `${channel}-linux.yml`]
}
