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

export interface Config {
  Port: number
  // Base URL of the real pod-webhook, used server-side to relay "send incoming webhook" calls -
  // the browser never talks to pod-webhook directly, so no CORS setup is needed.
  WebhookUrl: string
}

const config: Config = {
  Port: Number(process.env.PORT ?? 4044),
  WebhookUrl: process.env.WEBHOOK_URL ?? 'http://webhook:4043'
}

export default config
