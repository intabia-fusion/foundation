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

import { expect, test } from '../fixtures'
import path from 'path'

import { ChunterPage } from '../model/chunter-page'
import { createAccountAndWorkspace, generateTestData } from '../utils'

test.describe('Chat image container space reservation tests', () => {
  // Ensure deterministic DPR = 1
  test.use({ deviceScaleFactor: 1 })
  let chunterPage: ChunterPage
  let data: { workspaceName: string, userName: string, firstName: string, lastName: string, channelName: string }

  test.beforeEach(async ({ page, request }) => {
    data = generateTestData()

    chunterPage = new ChunterPage(page)
    // Straight into the workspace from the account token: the login form plus the workspace
    // picker are three page loads and cost about a second per test.
    await createAccountAndWorkspace(page, request, data, 'chunter')
  })

  const testImages = [
    {
      fileName: 'small-square-32x32.png',
      description: 'micro square 32x32',
      expectedWidth: 48,
      expectedHeight: 48
    },
    {
      fileName: 'small-horizontal-120x30.png',
      description: 'small horizontal 120x30',
      expectedWidth: 120,
      expectedHeight: 48
    },
    {
      fileName: 'small-vertical-30x120.png',
      description: 'small vertical 30x120',
      expectedWidth: 48,
      expectedHeight: 120
    },
    {
      fileName: 'landscape-panoramic-1200x300.png',
      description: 'ultra-wide panoramic 1200x300',
      expectedWidth: 400,
      expectedHeight: 100
    },
    {
      fileName: 'portrait-tall-200x800.png',
      description: 'ultra-tall 200x800',
      expectedWidth: 100,
      expectedHeight: 400
    }
  ]

  for (const { fileName, description, expectedWidth, expectedHeight } of testImages) {
    test(`Verify image loading flow for ${description}: 1) space reserved immediately, 2) preview exists, 3) dimensions unchanged after load`, async ({
      page
    }) => {
      // Intercept preview image render requests (_preview/image) to delay the load. 2.5s is enough:
      // the "reserved before load" checks below run within ~1.5s of sending, and every extra second
      // here is paid by all five variants of this test.
      await page.route('**/_preview/image/**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500))
        await route.continue()
      })

      await chunterPage.clickAddChannel()
      await chunterPage.createChannel(data.channelName, true)

      // Upload image fixture file from tests/sanity/tests/files/
      await page
        .locator('input[type="file"]')
        .first()
        .setInputFiles(path.join(__dirname, `../files/${fileName}`))
      await page.waitForTimeout(1000)

      // Send the message with attachment
      await page.keyboard.press('Enter')

      // Find the reserved container directly via page.getByTestId (mapped to data-id)
      const container = page.getByTestId('attachment-image-preview').first()
      // Container lookup must succeed immediately (within 1s), well before network response
      await expect(container).toBeVisible({ timeout: 1000 })

      // ==========================================
      // 1. Space reserved immediately (BEFORE LOAD) - Exact expected value assertion
      // ==========================================
      const boxBeforeLoad = await container.boundingBox()
      expect(boxBeforeLoad).not.toBeNull()
      expect(boxBeforeLoad?.width).toBeCloseTo(expectedWidth, 1)
      expect(boxBeforeLoad?.height).toBeCloseTo(expectedHeight, 1)

      // Verify reserved aspect-ratio in element inline style
      const styleAttr = await container.getAttribute('style')
      expect(styleAttr).toContain('aspect-ratio')

      // ==========================================
      // 2. Preview exists (Blurhash canvas during network loading)
      // ==========================================
      // Check preview immediately within 1s (while network request is delayed by 5s)
      const canvasPreview = container.locator('canvas').first()
      await expect(canvasPreview).toBeVisible({ timeout: 1000 })

      // ==========================================
      // 3. Dimensions after load remain unchanged - Exact expected value assertion
      // ==========================================
      // The route above holds the image for 5s. Wait for it to actually arrive rather than for a
      // sleep long enough to cover it - the assertion below is about the size after the load.
      const imgElement = container.locator('img').first()
      await expect(imgElement).toBeVisible({ timeout: 15000 })

      const boxAfterLoad = await container.boundingBox()
      expect(boxAfterLoad).not.toBeNull()

      // Dimensions after image load match expected concrete values exactly
      expect(boxAfterLoad?.width).toBeCloseTo(expectedWidth, 1)
      expect(boxAfterLoad?.height).toBeCloseTo(expectedHeight, 1)
    })
  }
})
