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

import config from './config'
import { createServer } from './server'
import { DeliveryStore } from './store'

export const main = (): void => {
  const app = createServer(config, new DeliveryStore())

  const server = app.listen(config.Port, () => {
    console.log(`Webhook mock listening on port ${config.Port}, relaying to ${config.WebhookUrl}`)
  })

  const shutdown = (): void => {
    server.close(() => process.exit())
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
