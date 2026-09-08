<script lang="ts">
  import core, { Data, Doc, Ref } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import { Grid, Label, Toggle } from '@hcengineering/ui'
  import notification, { NotificationAppearancePreference } from '@hcengineering/notification'

  import { appearancePreferences } from '../../stores'

  type PreferenceKey = keyof NotificationAppearancePreference

  const defaultData: Omit<Data<NotificationAppearancePreference>, 'attachedTo'> = {
    showChatBadge: true
  }

  async function doUpdate (propName: PreferenceKey, value: any): Promise<void> {
    const preference = $appearancePreferences
    if (preference != null) {
      await client.diffUpdate(preference, { [propName]: value })
    } else {
      await client.createDoc(notification.class.NotificationAppearancePreference, core.space.Workspace, {
        attachedTo: '',
        ...defaultData,
        [propName]: value
      })
    }
  }

  const client = getClient()
  function updater (propName: PreferenceKey) {
    return (e: CustomEvent) => {
      void doUpdate(propName, e.detail)
    }
  }
</script>

<div class="flex-grow vScroll w-full">
  <div class="container">
    <Grid column={2} columnGap={5} rowGap={1.5}>
      <div class="flex">
        <Label label={notification.string.ShowChatBadge} />
      </div>
      <div class="toggle">
        <Toggle
          on={$appearancePreferences?.showChatBadge ?? defaultData.showChatBadge}
          on:change={updater('showChatBadge')}
        />
      </div>
    </Grid>
  </div>
</div>

<style lang="scss">
  .container {
    width: fit-content;
  }

  .toggle {
    width: fit-content;
  }
</style>
