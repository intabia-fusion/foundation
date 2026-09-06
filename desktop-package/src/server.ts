/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

import { createDistServer, loadDistServerInfo } from './distServer'

const PORT = parseInt(process.env.PORT ?? '4409', 10)
const DIST_DIR = process.env.DIST_DIR ?? '/app/dist'

// A single broken download must never take the whole distribution server down:
// every in-flight client would lose its update.
process.on('uncaughtException', (err) => {
  console.error('[desktop-server] uncaught exception', err)
})
process.on('unhandledRejection', (err) => {
  console.error('[desktop-server] unhandled rejection', err)
})

const server = createDistServer(DIST_DIR)

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Desktop distribution server started on port ${PORT}`)
  console.log(`Serving files from: ${DIST_DIR}`)

  const { files, manifests } = loadDistServerInfo()
  if (files.length > 0) {
    console.log(`Available files (${files.length}):`)
    files.forEach((file) => {
      console.log(`  - ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`)
    })
  } else {
    console.log('Distribution directory not found or empty')
  }

  if (manifests.length > 0) {
    console.log('Loaded download manifests:')
    manifests.forEach((p) => {
      console.log(`  - ${p.platform}${p.variant !== undefined ? '/' + p.variant : ''}: ${p.manifest} => ${p.artifacts.length} artifact(s)`)
      p.artifacts.forEach((a) => console.log(`      * ${a.filename} (${a.url})`))
    })
  } else {
    console.log('No download manifests found (no latest-*.yml files)')
  }
})
