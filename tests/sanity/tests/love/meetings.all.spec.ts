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

import { test } from '../fixtures'
import { closeLoveWindows } from './meeting-helpers'

import { registerAccessTests } from './meetings.access.tests'
import { registerBidirectionalLoopTests } from './meetings.bidirectional-loop.tests'
import { registerRefreshReconnectTests } from './meetings.refresh-reconnect.tests'
import { registerConnectTests } from './meetings.connect.tests'
import { registerDeviceTests } from './meetings.devices.tests'
import { registerFinishedTokenTests } from './meetings.finished-token.tests'
import { registerHostRefreshTests } from './meetings.host-refresh.tests'
import { registerNetworkTests } from './meetings.network.tests'
import { registerPresenceTests } from './meetings.presence.tests'
import { registerGuestTests } from './meetings.guest.tests'
import { registerInviteTests } from './meetings.invite.tests'
import { registerInviteUiTests } from './meetings.invite-ui.tests'
import { registerKnockOfficeTests } from './meetings.knock-office.tests'
import { registerClientCreateTests } from './meetings.client-create.tests'
import { registerMeetingsTests } from './meetings.tests'
import { registerMigrationTests } from './meetings.migration.tests'
import { registerPrivacyTests } from './meetings.privacy.tests'
import { registerRecordingTests } from './meetings.recording.tests'
import { registerScenariosTests } from './meetings.scenarios.tests'
import { registerScheduledConnectTests } from './meetings.scheduled-connect.tests'
import { registerScheduledLinksTests } from './meetings.scheduled-links.tests'
import { registerSessionTests } from './meetings.session.tests'
import { registerStartTests } from './meetings.start.tests'
import { registerTransactorRestartTests } from './meetings.transactor-restart.tests'
import { registerWorkspaceOwnerTests } from './meetings.workspace-owner.tests'

test.describe('love (meetings) — suite', () => {
  // The per-user windows are shared by every test here; `closeMeetingContexts` rolls them back
  // after each one, this only tears them down at the end.
  test.afterAll(async () => {
    await closeLoveWindows()
  })

  registerMeetingsTests()
  registerAccessTests()
  registerMigrationTests()
  registerPrivacyTests()
  registerStartTests()
  registerSessionTests()
  registerInviteTests()
  registerInviteUiTests()
  registerConnectTests()
  registerDeviceTests()
  registerNetworkTests()
  registerPresenceTests()
  registerKnockOfficeTests()
  registerClientCreateTests()
  registerScenariosTests()
  registerWorkspaceOwnerTests()
  registerBidirectionalLoopTests()
  registerRefreshReconnectTests()
  registerGuestTests()
  registerScheduledLinksTests()
  registerHostRefreshTests()
  registerScheduledConnectTests()
  registerFinishedTokenTests()
  registerTransactorRestartTests()
  registerRecordingTests()
})
