# Sidebar widget tabs

## Model: three states per tab, like VSCode editors

`WidgetTab` carries two additive flags (`plugins/workbench/src/types.ts`):

| State | Flags | Look (`ModernTab`) | Replaced? |
| --- | --- | --- | --- |
| preview | neither | `primary`, italic | yes |
| kept | `isKept` | `primary` | no |
| pinned | `isPinned` (+`isKept`) | `secondary`, no close, sorted first | no |

Flags, not a `mode` enum, because widget state is persisted in localStorage per workspace
(`sidebar.ts` `getSidebarStateFromLocalStorage`) - adding a field needs no migration.

`createWidgetTab(widget, tab)` (`plugins/workbench-resources/src/sidebar.ts`):

- tab with the same `id` exists -> updated in place and focused (`isPinned`/`isKept` preserved)
- otherwise it replaces the widget's single **preview** tab (active one first, then any preview)
- no preview tab -> appended

Promotion preview -> kept is a **double click on the tab**, caught by the wrapper in
`SidebarTabs.svelte` so custom `tabComponent`s (`ChatWidgetTab`, `CardWidgetTab`) get it for free.
`unpinWidgetTab` drops to kept, not preview - otherwise unpinning would make the tab vanish on the
next open.

Widgets are independent: opening a card does not touch the chat widget state, only which widget is
active in the sidebar.

Tab ids must be deterministic per object, otherwise repeated opening produces duplicates:
`chunter_${_id}` (channel), `thread_${_id}`, `cardId`, `Ref<Blob>` (file), `preview_${_id}`
(universal doc preview - tracker, documents, anything with an `ObjectPanel`),
`'video'`/`'chat'`/`'transcription'` (meeting).

The universal preview id used to be the literal `'preview'`, which meant tracker and documents
always reused one tab and had no tab model at all.

## Removed: allowedPath auto-close

Before, `WidgetTab.allowedPath` + `closeWrongTabs` in `SidebarExpanded.svelte` closed unpinned
tabs whenever the URL left the allowed prefix - a chat thread died on app switch. Worse, the check
lived in a component mounted only in `EXPANDED` and only scanned the active widget's tabs, so the
behavior depended on whether the sidebar happened to be open. Both are gone; tabs live until the
user closes them or they get replaced by the scratch rule.

`openThreadInSidebar` still keeps its `force` flag: `force=false` is used by `Chat.svelte` to
restore a thread from the URL and must not steal the sidebar from another widget.

## Mobile

Not changed, but relevant:

- `Workbench.svelte`: any location change collapses the sidebar to `MINI` on `mobileAdaptive`;
  tab state survives, only the variant changes.
- `docWidth <= 1024` (`FLOAT_ASIDE`) -> `float` overlay; navigator and sidebar are mutually
  exclusive on narrow screens.
- `sidebar.ts` forces `variant = MINI` both when reading and writing localStorage on
  `isMobile && minWidth`, so the expanded state is effectively not persisted on mobile.
