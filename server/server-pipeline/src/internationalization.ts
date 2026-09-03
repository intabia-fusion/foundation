import { coreId } from '@hcengineering/core'
import { addStringsLoader, platformId } from '@hcengineering/platform'
import { activityId } from '@hcengineering/activity'
import { attachmentId } from '@hcengineering/attachment'
import { calendarId } from '@hcengineering/calendar'
import { chunterId } from '@hcengineering/chunter'
import { contactId } from '@hcengineering/contact'
import { documentsId } from '@hcengineering/controlled-documents'
import { documentId } from '@hcengineering/document'
import { exportId } from '@hcengineering/export'
import { driveId } from '@hcengineering/drive'
import { githubId } from '@hcengineering/github'
import { gmailId } from '@hcengineering/gmail'
import { hrId } from '@hcengineering/hr'
import { inventoryId } from '@hcengineering/inventory'
import { leadId } from '@hcengineering/lead'
import { loginId } from '@hcengineering/login'
import { loveId } from '@hcengineering/love'
import { notificationId } from '@hcengineering/notification'
import { onboardId } from '@hcengineering/onboard'
import { preferenceId } from '@hcengineering/preference'
import { productsId } from '@hcengineering/products'
import { recruitId } from '@hcengineering/recruit'
import { requestId } from '@hcengineering/request'
import { settingId } from '@hcengineering/setting'
import { supportId } from '@hcengineering/support'
import { tagsId } from '@hcengineering/tags'
import { taskId } from '@hcengineering/task'
import { telegramId } from '@hcengineering/telegram'
import { templatesId } from '@hcengineering/templates'
import { trackerId } from '@hcengineering/tracker'
import { trainingId } from '@hcengineering/training'
import { viewId } from '@hcengineering/view'
import { workbenchId } from '@hcengineering/workbench'
import { timeId } from '@hcengineering/time'
import { surveyId } from '@hcengineering/survey'
import { cardId } from '@hcengineering/card'
import { mailId } from '@hcengineering/mail'

import coreEng from '@hcengineering/core/lang/en.json'
import loginEng from '@hcengineering/login-assets/lang/en.json'
import platformEng from '@hcengineering/platform/lang/en.json'
import activityEn from '@hcengineering/activity-assets/lang/en.json'
import attachmentEn from '@hcengineering/attachment-assets/lang/en.json'
import calendarEn from '@hcengineering/calendar-assets/lang/en.json'
import chunterEn from '@hcengineering/chunter-assets/lang/en.json'
import contactEn from '@hcengineering/contact-assets/lang/en.json'
import documentsEn from '@hcengineering/controlled-documents-assets/lang/en.json'
import documentEn from '@hcengineering/document-assets/lang/en.json'
import exportEn from '@hcengineering/export-assets/lang/en.json'
import driveEn from '@hcengineering/drive-assets/lang/en.json'
import githubEn from '@hcengineering/github-assets/lang/en.json'
import gmailEn from '@hcengineering/gmail-assets/lang/en.json'
import hrEn from '@hcengineering/hr-assets/lang/en.json'
import inventoryEn from '@hcengineering/inventory-assets/lang/en.json'
import leadEn from '@hcengineering/lead-assets/lang/en.json'
import loveEn from '@hcengineering/love-assets/lang/en.json'
import notificationEn from '@hcengineering/notification-assets/lang/en.json'
import onboardEn from '@hcengineering/onboard-assets/lang/en.json'
import preferenceEn from '@hcengineering/preference-assets/lang/en.json'
import productsEn from '@hcengineering/products-assets/lang/en.json'
import recruitEn from '@hcengineering/recruit-assets/lang/en.json'
import requestEn from '@hcengineering/request-assets/lang/en.json'
import settingEn from '@hcengineering/setting-assets/lang/en.json'
import supportEn from '@hcengineering/support-assets/lang/en.json'
import tagsEn from '@hcengineering/tags-assets/lang/en.json'
import taskEn from '@hcengineering/task-assets/lang/en.json'
import telegramEn from '@hcengineering/telegram-assets/lang/en.json'
import templatesEn from '@hcengineering/templates-assets/lang/en.json'
import trackerEn from '@hcengineering/tracker-assets/lang/en.json'
import trainingEn from '@hcengineering/training-assets/lang/en.json'
import viewEn from '@hcengineering/view-assets/lang/en.json'
import workbenchEn from '@hcengineering/workbench-assets/lang/en.json'
import timeEn from '@hcengineering/time-assets/lang/en.json'
import surveyEn from '@hcengineering/survey-assets/lang/en.json'
import cardEn from '@hcengineering/card-assets/lang/en.json'
import mailEn from '@hcengineering/mail-assets/lang/en.json'
import workflowEn from '@hcengineering/workflow-assets/lang/en.json'
import coreRu from '@hcengineering/core/lang/ru.json'
import workflowRu from '@hcengineering/workflow-assets/lang/ru.json'
import { workflowId } from '@hcengineering/workflow'
import loginRu from '@hcengineering/login-assets/lang/ru.json'
import platformRu from '@hcengineering/platform/lang/ru.json'
import activityRu from '@hcengineering/activity-assets/lang/ru.json'
import attachmentRu from '@hcengineering/attachment-assets/lang/ru.json'
import calendarRu from '@hcengineering/calendar-assets/lang/ru.json'
import chunterRu from '@hcengineering/chunter-assets/lang/ru.json'
import contactRu from '@hcengineering/contact-assets/lang/ru.json'
import documentsRu from '@hcengineering/controlled-documents-assets/lang/ru.json'
import documentRu from '@hcengineering/document-assets/lang/ru.json'
import exportRu from '@hcengineering/export-assets/lang/ru.json'
import driveRu from '@hcengineering/drive-assets/lang/ru.json'
import githubRu from '@hcengineering/github-assets/lang/ru.json'
import gmailRu from '@hcengineering/gmail-assets/lang/ru.json'
import hrRu from '@hcengineering/hr-assets/lang/ru.json'
import inventoryRu from '@hcengineering/inventory-assets/lang/ru.json'
import leadRu from '@hcengineering/lead-assets/lang/ru.json'
import loveRu from '@hcengineering/love-assets/lang/ru.json'
import notificationRu from '@hcengineering/notification-assets/lang/ru.json'
import onboardRu from '@hcengineering/onboard-assets/lang/ru.json'
import preferenceRu from '@hcengineering/preference-assets/lang/ru.json'
import productsRu from '@hcengineering/products-assets/lang/ru.json'
import recruitRu from '@hcengineering/recruit-assets/lang/ru.json'
import requestRu from '@hcengineering/request-assets/lang/ru.json'
import settingRu from '@hcengineering/setting-assets/lang/ru.json'
import supportRu from '@hcengineering/support-assets/lang/ru.json'
import tagsRu from '@hcengineering/tags-assets/lang/ru.json'
import taskRu from '@hcengineering/task-assets/lang/ru.json'
import telegramRu from '@hcengineering/telegram-assets/lang/ru.json'
import templatesRu from '@hcengineering/templates-assets/lang/ru.json'
import trackerRu from '@hcengineering/tracker-assets/lang/ru.json'
import trainingRu from '@hcengineering/training-assets/lang/ru.json'
import viewRu from '@hcengineering/view-assets/lang/ru.json'
import workbenchRu from '@hcengineering/workbench-assets/lang/ru.json'
import timeRu from '@hcengineering/time-assets/lang/ru.json'
import surveyRu from '@hcengineering/survey-assets/lang/ru.json'
import cardRu from '@hcengineering/card-assets/lang/ru.json'
import mailRu from '@hcengineering/mail-assets/lang/ru.json'

function createLoader (en: any, ru: any): (lang: string) => Promise<any> {
  return async (lang: string) => {
    switch (lang) {
      case 'en':
        return en
      case 'ru':
        return ru
      default:
        return en
    }
  }
}

export function registerStringLoaders (): void {
  addStringsLoader(coreId, createLoader(coreEng, coreRu))
  addStringsLoader(loginId, createLoader(loginEng, loginRu))
  addStringsLoader(onboardId, createLoader(onboardEn, onboardRu))
  addStringsLoader(platformId, createLoader(platformEng, platformRu))
  addStringsLoader(taskId, createLoader(taskEn, taskRu))
  addStringsLoader(viewId, createLoader(viewEn, viewRu))
  addStringsLoader(chunterId, createLoader(chunterEn, chunterRu))
  addStringsLoader(attachmentId, createLoader(attachmentEn, attachmentRu))
  addStringsLoader(contactId, createLoader(contactEn, contactRu))
  addStringsLoader(recruitId, createLoader(recruitEn, recruitRu))
  addStringsLoader(activityId, createLoader(activityEn, activityRu))
  addStringsLoader(settingId, createLoader(settingEn, settingRu))
  addStringsLoader(supportId, createLoader(supportEn, supportRu))
  addStringsLoader(telegramId, createLoader(telegramEn, telegramRu))
  addStringsLoader(leadId, createLoader(leadEn, leadRu))
  addStringsLoader(gmailId, createLoader(gmailEn, gmailRu))
  addStringsLoader(workbenchId, createLoader(workbenchEn, workbenchRu))
  addStringsLoader(inventoryId, createLoader(inventoryEn, inventoryRu))
  addStringsLoader(templatesId, createLoader(templatesEn, templatesRu))
  addStringsLoader(notificationId, createLoader(notificationEn, notificationRu))
  addStringsLoader(tagsId, createLoader(tagsEn, tagsRu))
  addStringsLoader(calendarId, createLoader(calendarEn, calendarRu))
  addStringsLoader(trackerId, createLoader(trackerEn, trackerRu))
  addStringsLoader(preferenceId, createLoader(preferenceEn, preferenceRu))
  addStringsLoader(hrId, createLoader(hrEn, hrRu))
  addStringsLoader(documentId, createLoader(documentEn, documentRu))
  addStringsLoader(exportId, createLoader(exportEn, exportRu))
  addStringsLoader(requestId, createLoader(requestEn, requestRu))
  addStringsLoader(loveId, createLoader(loveEn, loveRu))
  addStringsLoader(driveId, createLoader(driveEn, driveRu))
  addStringsLoader(documentsId, createLoader(documentsEn, documentsRu))
  addStringsLoader(productsId, createLoader(productsEn, productsRu))
  addStringsLoader(trainingId, createLoader(trainingEn, trainingRu))
  addStringsLoader(githubId, createLoader(githubEn, githubRu))
  addStringsLoader(timeId, createLoader(timeEn, timeRu))
  addStringsLoader(surveyId, createLoader(surveyEn, surveyRu))
  addStringsLoader(cardId, createLoader(cardEn, cardRu))
  addStringsLoader(mailId, createLoader(mailEn, mailRu))
  addStringsLoader(workflowId, createLoader(workflowEn, workflowRu))
}
