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

import type { Employee } from '@hcengineering/contact'
import type { AttachedData, Class, DocumentUpdate, Ref, Space, Timestamp, TxOperations } from '@hcengineering/core'
import type { Issue, TimeSpendReport } from '@hcengineering/tracker'

import tracker from '../../../plugin'

export interface TimeReportCreateData {
  date: Timestamp
  description: string
  value: number | undefined
  employee: Ref<Employee> | null
}

export interface DraftTimeReportPayload {
  reportedTime: number
  draftReports?: TimeSpendReport[]
  deletedReportIds?: Array<Ref<TimeSpendReport>>
  updatedReports?: TimeSpendReport[]
}

export interface ITimeReportService {
  readonly isDraft: boolean
  addReport: (
    space: Ref<Space>,
    issueId: Ref<Issue>,
    issueClass: Ref<Class<Issue>>,
    data: TimeReportCreateData
  ) => Promise<void>
  updateReport: (value: TimeSpendReport, data: TimeReportCreateData) => Promise<void>
  deleteReport: (report: TimeSpendReport) => Promise<void>
  subscribe?: (listener: () => void) => () => void
}

export class DirectTimeReportService implements ITimeReportService {
  readonly isDraft = false

  constructor (private readonly client: TxOperations) {}

  async addReport (
    space: Ref<Space>,
    issueId: Ref<Issue>,
    issueClass: Ref<Class<Issue>>,
    data: TimeReportCreateData
  ): Promise<void> {
    await this.client.addCollection(
      tracker.class.TimeSpendReport,
      space,
      issueId,
      issueClass,
      'reports',
      data as AttachedData<TimeSpendReport>
    )
  }

  async updateReport (value: TimeSpendReport, data: TimeReportCreateData): Promise<void> {
    const ops: DocumentUpdate<TimeSpendReport> = {}
    if (value.value !== data.value) ops.value = data.value
    if (value.employee !== data.employee) ops.employee = data.employee
    if (value.description !== data.description) ops.description = data.description
    if (value.date !== data.date) ops.date = data.date

    if (Object.keys(ops).length > 0) {
      await this.client.update(value, ops)
    }
  }

  async deleteReport (report: TimeSpendReport): Promise<void> {
    await this.client.removeCollection(
      report._class,
      report.space,
      report._id,
      report.attachedTo,
      report.attachedToClass,
      report.collection ?? 'reports'
    )
  }
}

export class DraftTimeReportService implements ITimeReportService {
  readonly isDraft = true
  private draftReports: TimeSpendReport[] = []
  private readonly deletedReportIds = new Set<Ref<TimeSpendReport>>()
  private readonly deletedReportValues = new Map<Ref<TimeSpendReport>, number>()
  private listeners: Array<() => void> = []

  constructor (
    private readonly onChange?: (value: DraftTimeReportPayload) => void,
    private readonly currentReportedTime: number = 0
  ) {}

  subscribe (listener: () => void): () => void {
    this.listeners.push(listener)
    listener()
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  getDraftReports (): TimeSpendReport[] {
    return [...this.draftReports]
  }

  isReportDeleted (id: Ref<TimeSpendReport>): boolean {
    return this.deletedReportIds.has(id)
  }

  private notify (): void {
    const addedTime = this.draftReports.reduce((acc, r) => acc + (r.value ?? 0), 0)
    const deletedTime = Array.from(this.deletedReportValues.values()).reduce((acc, v) => acc + v, 0)
    const newTotal = Math.max(0, this.currentReportedTime + addedTime - deletedTime)

    if (this.onChange != null) {
      this.onChange({
        reportedTime: newTotal,
        draftReports: this.draftReports,
        deletedReportIds: Array.from(this.deletedReportIds)
      })
    }

    for (const listener of this.listeners) {
      try {
        listener()
      } catch (e) {
        console.error(e)
      }
    }
  }

  async addReport (
    space: Ref<Space>,
    issueId: Ref<Issue>,
    issueClass: Ref<Class<Issue>>,
    data: TimeReportCreateData
  ): Promise<void> {
    const draftId =
      `draft_${Date.now()}_${Math.random().toString(36).substring(2, 7)}` as unknown as Ref<TimeSpendReport>
    const draftItem: TimeSpendReport = {
      _id: draftId,
      _class: tracker.class.TimeSpendReport,
      space,
      attachedTo: issueId,
      attachedToClass: issueClass,
      collection: 'reports',
      date: data.date,
      description: data.description,
      value: data.value ?? 0,
      employee: data.employee
    } as unknown as TimeSpendReport

    this.draftReports = [...this.draftReports, draftItem]
    this.notify()
  }

  async updateReport (value: TimeSpendReport, data: TimeReportCreateData): Promise<void> {
    const index = this.draftReports.findIndex((r) => r._id === value._id)
    if (index !== -1) {
      this.draftReports[index] = {
        ...this.draftReports[index],
        date: data.date,
        description: data.description,
        value: data.value ?? 0,
        employee: data.employee
      }
      this.notify()
    }
  }

  async deleteReport (report: TimeSpendReport): Promise<void> {
    const draftIndex = this.draftReports.findIndex((r) => r._id === report._id)
    if (draftIndex !== -1) {
      this.draftReports = this.draftReports.filter((_, i) => i !== draftIndex)
    } else {
      this.deletedReportIds.add(report._id)
      this.deletedReportValues.set(report._id, report.value ?? 0)
    }
    this.notify()
  }
}
