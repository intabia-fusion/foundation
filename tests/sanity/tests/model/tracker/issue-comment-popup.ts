import { IssuesPage } from './issues-page'
import { type Locator, expect } from '@playwright/test'
import path from 'path'
import { retryIntervals } from '../../retry'

export class IssueCommentPopup extends IssuesPage {
  inputCommentText = (): Locator => this.page.locator('div[class*="commentPopup"] div.tiptap')
  inputAttachFile = (): Locator => this.page.locator('div[class*="commentPopup"] input#file')
  textAttachFileName = (): Locator => this.page.locator('div[class*="commentPopup"] div[class*="attachment"] div.name')
  buttonSendComment = (): Locator =>
    this.page.locator('div[class*="commentPopup"] div.buttons-panel > button[type="button"]')

  async addCommentInPopup (commentText: string, attachmentFileName?: string): Promise<void> {
    await this.inputCommentText().fill(commentText)
    if (attachmentFileName != null) {
      await this.inputAttachFile().setInputFiles(path.join(__dirname, `../../files/${attachmentFileName}`))
      // AttachmentPresenter renders nothing until getBlobRef resolves, so this waits out the upload
      // and the preview metadata round-trip - more than the 15s default allows under parallel load.
      await expect(this.textAttachFileName()).toHaveText(attachmentFileName, { timeout: 45000 })
    }

    // `disabled={!canSubmit}` while the attachment uploads (ReferenceInput.svelte): clicking a
    // disabled button waits out the whole test timeout and reports nothing about the upload.
    // A popup that goes away instead of enabling means the row under it re-rendered - say so.
    await expect(async () => {
      if ((await this.page.locator('div[class*="commentPopup"]').count()) === 0) {
        throw new Error('comment popup closed before the send button became enabled')
      }
      await expect(this.buttonSendComment()).toBeEnabled({ timeout: 3000 })
    }).toPass({ intervals: retryIntervals, timeout: 30000 })
    await this.buttonSendComment().click()
  }
}
