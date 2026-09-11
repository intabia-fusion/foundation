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

  async addCommentInPopup (issueName: string, commentText: string, attachmentFileName?: string): Promise<void> {
    const popup = this.page.locator('div[class*="commentPopup"]')
    // The popup is anchored to the issue row, and any live update to the list re-renders the row
    // and takes the popup with it - mid-upload it left the wait below staring at nothing for its
    // whole timeout. Reopen and refill instead of waiting a dead popup out.
    await expect(async () => {
      await this.openCommentPopupForIssueByName(issueName)
      await this.inputCommentText().fill(commentText)
      if (attachmentFileName != null) {
        // A reopened popup restores its draft, the attachment included - attaching again posts the
        // file twice and the comment then carries two images.
        if ((await this.textAttachFileName().count()) === 0) {
          await this.inputAttachFile().setInputFiles(path.join(__dirname, `../../files/${attachmentFileName}`))
        }
        // AttachmentPresenter renders nothing until getBlobRef resolves, so this waits out the
        // upload and the preview metadata round-trip - more than the 15s default allows under
        // parallel load.
        await expect(async () => {
          if ((await popup.count()) === 0) throw new Error('comment popup closed during the upload')
          await expect(this.textAttachFileName()).toHaveText(attachmentFileName, { timeout: 2000 })
        }).toPass({ intervals: retryIntervals, timeout: 45000 })
      }

      // `disabled={!canSubmit}` while the attachment uploads (ReferenceInput.svelte): clicking a
      // disabled button waits out the whole test timeout and reports nothing about the upload.
      if ((await popup.count()) === 0) throw new Error('comment popup closed before the send button became enabled')
      await expect(this.buttonSendComment()).toBeEnabled({ timeout: 5000 })
    }).toPass({ intervals: retryIntervals, timeout: 90000 })
    await this.buttonSendComment().click()
  }
}
