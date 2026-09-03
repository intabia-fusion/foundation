<script lang="ts">
  import { SelectPopup } from '@hcengineering/ui'
  import { Ref } from '@hcengineering/core'
  import { createEventDispatcher } from 'svelte'
  import { Employee, formatName } from '@hcengineering/contact'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { Avatar } from '@hcengineering/contact-resources'

  import { openDirectForPerson } from '../../utils'

  export let value: Employee[]

  const dispatch = createEventDispatcher()

  async function select (_id: Ref<Employee>): Promise<void> {
    const employee = value.find((it) => it._id === _id)
    if (employee !== undefined) {
      await openDirectForPerson(employee, true)
    }
    dispatch('close')
  }
</script>

<SelectPopup
  value={value.map((it) => ({
    id: it._id,
    icon: Avatar,
    iconProps: { person: it, size: 'tiny', name: it.name },
    label: getEmbeddedLabel(formatName(it.name)),
    isSelected: false
  }))}
  on:close={(evt) => {
    void select(evt.detail)
  }}
  searchable={false}
  componentLink
  width="medium"
  size="small"
  embedded={false}
  on:changeContent
/>
