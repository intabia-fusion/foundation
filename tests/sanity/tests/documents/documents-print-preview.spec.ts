import { test, expect } from '../fixtures'
import { generateId, PlatformSetting, PlatformURI } from '../utils'
import { NewDocument } from '../model/documents/types'
import { DocumentsPage } from '../model/documents/documents-page'
import { DocumentContentPage } from '../model/documents/document-content-page'
import { PDFParse } from 'pdf-parse'
import { retry } from '../retry'

test.use({ storageState: PlatformSetting })

const PRINT_ACTION_LABEL = 'Print to PDF'

const TITLES_TO_CHECK = [
  { label: 'latin', title: 'Print Preview Latin' },
  { label: 'cyrillic', title: 'Тестовый документ' },
  { label: 'cyrillic with space', title: 'Без имени' },
  { label: 'slash', title: 'GitFlow/CI-CD' },
  { label: 'special chars', title: 'Имя с &спец =символами' }
]

test.describe('Открытие pdf-preview документов через print сервис', () => {
  let documentsPage: DocumentsPage
  let documentContentPage: DocumentContentPage

  test.beforeEach(async ({ page }) => {
    documentsPage = new DocumentsPage(page)
    documentContentPage = new DocumentContentPage(page)
    await page.goto(`${PlatformURI}/workbench/sanity-ws/document`)
  })

  for (const { label, title } of TITLES_TO_CHECK) {
    test(`Открытие документа "${label}`, async ({ page }) => {
      const failedResponses: string[] = []

      page.on('response', (response) => {
        const url = response.url()
        if ((url.includes('/_print/') || url.includes('/_datalake/blob/')) && response.status() >= 400) {
          failedResponses.push(`${response.status()} ${url}`)
        }
      })

      // Suffix keeps the title unique per run: a leftover document from a previous run
      // makes every navigator locator ambiguous and fails the test on strict mode.
      const uniqueTitle = `${title} ${generateId(5)}`
      const newDocument: NewDocument = { title: uniqueTitle, space: 'Default' }

      await test.step('Создание и открытие документа', async () => {
        await documentsPage.clickOnButtonCreateDocument()
        await documentsPage.createDocument(newDocument)
        await documentsPage.openDocument(newDocument.title)
        await documentContentPage.checkDocumentTitle(newDocument.title)
      })

      await test.step('Вызов print-превью и проверка заголовка в теле PDF', async () => {
        const pdfPreview = page.locator('iframe[src*="blob"]').first()
        // Called right after creation the print service can return a pdf holding only the page
        // footer, and that blob never changes - ask for the print again, not for the blob.
        await retry(async () => {
          if (await pdfPreview.isVisible()) await page.keyboard.press('Escape')
          await documentsPage.moreActionsOnDocument(newDocument.title, PRINT_ACTION_LABEL)
          await expect(pdfPreview).toBeVisible({ timeout: 30000 })

          const srcRaw = await pdfPreview.getAttribute('src')
          expect(srcRaw).toBeTruthy()
          const src = (srcRaw as string).split('#')[0]

          const pdfResponse = await page.request.get(src)
          expect(pdfResponse.ok()).toBeTruthy()

          const parser = new PDFParse({ data: new Uint8Array(await pdfResponse.body()) })
          try {
            const result = await parser.getText()
            const text = result.text.replace(/\s+/g, ' ').trim()
            // Only the base title is asserted: the print service truncates long headers,
            // so the uniqueness suffix may not survive into the PDF.
            expect(text).toContain(title)
          } finally {
            await parser.destroy()
          }
        }, 90000)
      })

      await test.step('Проверка отсутствия ошибок в запросах print/datalake', async () => {
        expect(failedResponses).toEqual([])
      })
    })
  }
})
