<script lang="ts">
  import contact, { Person, Employee } from '@hcengineering/contact'
  import { EmployeePresenter } from '@hcengineering/contact-resources'
  import { getClient } from '@hcengineering/presentation'
  import { location, Location } from '@hcengineering/ui'
  import { chunterId } from '@hcengineering/chunter'
  import { notificationId } from '@hcengineering/notification'

  import { openDirectForPerson } from '../utils'

  export let person: Person | undefined

  const client = getClient()
  const hierarchy = client.getHierarchy()

  function canNavigateToDirect (location: Location, person: Person | undefined): boolean {
    const app = location.path[2]
    if (app !== chunterId && app !== notificationId) {
      return false
    }

    if (person === undefined) {
      return false
    }

    return hierarchy.hasMixin(person, contact.mixin.Employee) && (person as Employee).active
  }

  async function openEmployeeDirect (): Promise<void> {
    if (person === undefined) return
    await openDirectForPerson(person)
  }
</script>

<EmployeePresenter
  value={person}
  shouldShowAvatar={false}
  compact
  onEmployeeEdit={canNavigateToDirect($location, person) ? openEmployeeDirect : undefined}
/>
