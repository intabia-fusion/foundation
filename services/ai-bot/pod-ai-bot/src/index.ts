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
import { config } from 'dotenv'

import { startQueue, startEventRouterMode, startLlmRouterMode, startSttWorkerMode } from './queue'
import aibotConfig from './config'
import { startClient } from './client'
import { registerStringLoaders } from './internationalization'

config()
registerStringLoaders()

switch (aibotConfig.Mode) {
  case 'event-router':
    void startEventRouterMode()
    break
  case 'llm-router':
    void startLlmRouterMode()
    break
  case 'stt-worker':
    void startSttWorkerMode()
    break
  case 'client':
    void startClient()
    break
  case 'all':
  case 'queue':
  default:
    void startQueue()
    break
}
