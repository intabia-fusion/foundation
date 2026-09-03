<!--
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import contact from '@hcengineering/contact'
  import { UserBox } from '@hcengineering/contact-resources'
  import { SortingOrder } from '@hcengineering/core'
  import presentation, { createQuery } from '@hcengineering/presentation'
  import { Issue, TimeSpendReport } from '@hcengineering/tracker'
  import {
    ActionIcon,
    CheckBox,
    DatePresenter,
    eventToHTMLElement,
    IconDelete,
    Label,
    Menu,
    Scroller,
    showPopup,
    tableSP
  } from '@hcengineering/ui'
  import viewPlugin from '@hcengineering/view-resources/src/plugin'

  import tracker from '../../../plugin'
  import TimePresenter from './TimePresenter.svelte'
  import { DraftTimeReportService } from './service'

  export let issue: Issue
  export let service: DraftTimeReportService
  export let selectedReports: TimeSpendReport[] = []

  const reportsQuery = createQuery()
  let dbReports: TimeSpendReport[] = []
  let draftReports: TimeSpendReport[] = []
  let unsubscribe: (() => void) | undefined

  $: queryKey = issue?._id
    ? `${issue._id}:${
        issue.childInfo
          ?.map((it) => it.childId)
          .sort()
          .join(',') ?? ''
      }`
    : ''

  $: if (queryKey !== '') {
    const ids = [issue._id, ...(issue.childInfo?.map((it) => it.childId) ?? [])]
    reportsQuery.query(
      tracker.class.TimeSpendReport,
      { attachedTo: { $in: ids } },
      (result) => {
        dbReports = result
      },
      {
        sort: { date: SortingOrder.Descending },
        lookup: {
          attachedTo: tracker.class.Issue,
          employee: contact.mixin.Employee
        }
      }
    )
  }

  $: if (service != null) {
    unsubscribe?.()
    unsubscribe = service.subscribe(() => {
      draftReports = service.getDraftReports()
    })
  } else {
    draftReports = []
  }

  onDestroy(() => {
    unsubscribe?.()
  })

  $: allReports = [...draftReports, ...dbReports.filter((r) => !service.isReportDeleted(r._id))].sort(
    (a, b) => (b.date ?? 0) - (a.date ?? 0)
  )

  $: draftIdSet = new Set<string>(draftReports.map((r) => r._id))
  $: checkedSet = new Set<string>(selectedReports.map((r) => r._id))
  $: allItemsSelected = allReports.length > 0 && checkedSet.size === allReports.length

  function toggleCheck (report: TimeSpendReport, value: boolean): void {
    if (value) {
      if (!checkedSet.has(report._id)) {
        selectedReports = [...selectedReports, report]
      }
    } else {
      selectedReports = selectedReports.filter((r) => r._id !== report._id)
    }
  }

  function toggleAll (value: boolean): void {
    if (value) {
      selectedReports = [...allReports]
    } else {
      selectedReports = []
    }
  }

  export async function deleteReport (report: TimeSpendReport): Promise<void> {
    await service.deleteReport(report)
    draftReports = service.getDraftReports()
    selectedReports = selectedReports.filter((r) => r._id !== report._id)
  }

  export async function deleteSelected (): Promise<void> {
    if (selectedReports.length === 0) return
    const targets = [...selectedReports]
    for (const r of targets) {
      await deleteReport(r)
    }
    selectedReports = []
  }

  function handleContextMenu (event: MouseEvent, report: TimeSpendReport): void {
    event.preventDefault()

    let targets = selectedReports
    if (!checkedSet.has(report._id)) {
      targets = [report]
    }

    showPopup(
      Menu,
      {
        actions: [
          {
            label: presentation.string.Delete,
            icon: IconDelete,
            action: async () => {
              for (const r of targets) {
                await deleteReport(r)
              }
            }
          }
        ]
      },
      eventToHTMLElement(event)
    )
  }
</script>

<div class="h-full flex-col min-h-0 relative flex-grow overflow-hidden">
  <Scroller fade={tableSP}>
    <table class="antiTable highlightRows metaColumn">
      <thead class="scroller-thead">
        <tr class="scroller-thead__tr">
          <th class="check-col">
            <div class="antiTable-cells__checkCell" class:checkall={checkedSet.size > 0}>
              <CheckBox
                symbol={allItemsSelected ? 'check' : 'minus'}
                checked={checkedSet.size > 0}
                on:value={(event) => {
                  toggleAll(event.detail)
                }}
              />
            </div>
          </th>
          <th><div class="antiTable-cells"><Label label={tracker.string.TimeSpendReportValue} /></div></th>
          <th><div class="antiTable-cells"><Label label={contact.string.Employee} /></div></th>
          <th><div class="antiTable-cells"><Label label={tracker.string.TimeSpendReportDate} /></div></th>
          <th><div class="antiTable-cells"><Label label={tracker.string.TimeSpendReportDescription} /></div></th>
          <th class="action-col" />
        </tr>
      </thead>
      <tbody>
        {#if allReports.length === 0}
          <tr class="antiTable-body__row">
            <td colspan="6" class="empty-cell text-center p-8">
              <div class="flex flex-col items-center justify-center gap-2 py-4">
                <span class="caption-color text-sm">
                  <Label label={tracker.string.TimeSpendReports} />
                </span>
              </div>
            </td>
          </tr>
        {:else}
          {#each allReports as report (report._id)}
            {@const isDraft = draftIdSet.has(report._id)}
            <tr
              class="antiTable-body__row row-item"
              class:draft-row={isDraft}
              class:checking={checkedSet.has(report._id)}
              class:selected={checkedSet.has(report._id)}
              on:contextmenu={(ev) => {
                handleContextMenu(ev, report)
              }}
            >
              <td class="check-col">
                <div class="antiTable-cells__checkCell">
                  <CheckBox
                    checked={checkedSet.has(report._id)}
                    on:value={(event) => {
                      toggleCheck(report, event.detail)
                    }}
                  />
                </div>
              </td>
              <td>
                <div class="flex items-center gap-2">
                  <TimePresenter value={report.value ?? 0} />
                  {#if isDraft}
                    <span class="draft-badge" title="Draft">(<Label label={presentation.string.Draft} />)</span>
                  {/if}
                </div>
              </td>
              <td>
                <UserBox
                  width="100%"
                  kind="ghost"
                  size="small"
                  label={contact.string.Employee}
                  _class={contact.mixin.Employee}
                  value={report.employee}
                  showNavigate={false}
                  readonly
                />
              </td>
              <td>
                <DatePresenter value={report.date} kind="ghost" size="small" />
              </td>
              <td class="description-col">
                <span class="description-text" title={report.description || ''}>
                  {report.description || '—'}
                </span>
              </td>
              <td class="action-col">
                <div class="action-btn">
                  <ActionIcon
                    icon={IconDelete}
                    size="small"
                    action={(ev) => {
                      ev.stopPropagation()
                      void deleteReport(report)
                    }}
                  />
                </div>
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </Scroller>

  <div class="footer">
    <div class="content padding">
      <span class="select-text">
        <Label label={viewPlugin.string.Total} params={{ total: allReports.length }} />
      </span>
    </div>
  </div>
</div>

<style lang="scss">
  .antiTable {
    width: 100%;
    min-width: 36rem;

    .check-col {
      width: 2.5rem;
      min-width: 2.5rem;
      max-width: 2.5rem;
      padding: 0;
      text-align: center;
    }

    .action-col {
      width: 2.5rem;
      min-width: 2.5rem;
      max-width: 2.5rem;
      padding: 0 0.5rem;
      text-align: center;

      .action-btn {
        opacity: 0;
        transition: opacity 0.15s ease-in-out;
      }
    }

    .row-item:hover {
      .action-btn {
        opacity: 1;
      }
    }

    .draft-row {
      background-color: var(--theme-accent-color-transparent, rgba(59, 130, 246, 0.08));
    }

    .draft-badge {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--theme-primary-color, #3b82f6);
      background: var(--theme-accent-color-transparent, rgba(59, 130, 246, 0.15));
      border-radius: 0.25rem;
      padding: 0.125rem 0.375rem;
      line-height: 1;
      display: inline-flex;
      align-items: center;
    }

    .description-col {
      max-width: 16rem;

      .description-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        display: block;
        color: var(--theme-caption-color);
      }
    }
  }

  .footer {
    width: 100%;
    background-color: var(--theme-comp-header-color);
    display: flex;
    align-items: center;
    height: 2.5rem;
    z-index: 2;
    position: sticky;
    bottom: 0;
    border-top: 1px solid var(--theme-divider-color);

    .content {
      display: flex;
      align-items: center;
      width: 100%;
      &.padding {
        padding-left: 2.5rem;
      }
    }
  }
</style>
