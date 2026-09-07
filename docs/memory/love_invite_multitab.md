# Invite/knock multi-tab guards

## Sender tab identity (`senderSessionId`)

`UserMeetingInvite.senderSessionId` is written by `sendInvites` / `sendKnockRequest`
and checked in `checkAndJoinIfRecipientJoined` (`plugins/love-resources/src/invites.ts`).
Without it every tab of the caller reacted to `status: 'accepted'`; in the A2 branch
(no meeting yet) each tab called `createMeeting`, producing duplicate meetings in the
caller's office.

`notMatch` in `sendInvites` does not include the new field, so a second tab still
cannot create a duplicate request - the invite keeps the session of the tab that won.

## Empty `SessionId`

`presentation.metadata.SessionId` defaults to `''` and is only set on
`ClientConnectEvent.Connected` (`plugins/workbench-resources/src/connect.ts`). The
old `getMetadata(...) ?? undefined` kept `''`, and `'' === ''` made every tab look
like the accepting one - the guard silently disabled itself. `mySessionId()` in
invites.ts normalizes `''` to `undefined`, which degrades to "all tabs act" instead
of "wrong tab acts".

The id itself is `ClisrClient.sessionId`: stable across a reconnect (same client
instance) and across F5 (stored in sessionStorage on `beforeunload`).

## Duplicate knock chips

`createInviteResponseTx` (`server-plugins/love-resources/src/index.ts`) now refuses to
create a second pending `invite-response` for the same `(from, to, room|meeting)`.
Client-side `notMatch` only dedups *requests*; a request that dies by `TransientTTL`
emits no `TxRemoveDoc`, so its response survives and a re-knock stacked another chip
in `KnockingList`.
