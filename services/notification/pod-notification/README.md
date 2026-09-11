# Notification Service

A background worker that delivers push notifications: web push to browsers, APNs to iOS and FCM to Android.

## Overview

The service consumes `QueueNotificationMessage` payloads from the platform queue
(`QueueTopic.UserNotifications`) and delivers them to every push subscription carried by the
message. Web Push is signed with VAPID keys; native subscriptions go to APNs or FCM instead.
Subscriptions the transport reports as dead are removed from the workspace through the
transactor, so no cleanup is required from the caller.

There is no HTTP API - the service does not listen on a port.

## Features

- **Web Push Notifications**: Send push notifications to web browsers
- **Native Push**: APNs and FCM delivery for the mobile apps, chosen per subscription
- **VAPID Support**: Secure authentication using VAPID keys
- **Queue Consumer**: Kafka-backed consumer with retries and poison-message acknowledgement
- **Subscription Cleanup**: Expired and invalid subscriptions are deleted via the transactor

## Prerequisites

- Node.js (version specified in package.json)
- A reachable platform queue (Kafka / Redpanda), accounts service and transactor
- VAPID key pair for web push authentication
- APNs and/or FCM credentials for mobile delivery

## Configuration

The service is configured via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SOURCE` | Yes | - | Source identifier for the service |
| `ACCOUNTS_URL` | Yes | - | Accounts service endpoint, used to resolve the transactor |
| `SECRET` | Yes | - | Server secret used to sign the system token |
| `QUEUE_CONFIG` | No | - | Queue (Kafka/Redpanda) connection string |
| `QUEUE_REGION` | No | - | Queue region |
| `SERVICE_ID` | No | `web-push-service` | Service identifier used for tracing, queue client IDs and tokens |
| `TTL` | No | `86400` | Push TTL in seconds (24 hours) |
| `PUSH_PUBLIC_KEY` | No | - | VAPID public key for web push |
| `PUSH_PRIVATE_KEY` | No | - | VAPID private key for web push |
| `PUSH_SUBJECT` | No | `mailto:hey@huly.io` | VAPID subject (email or URL) |
| `APNS_KEY_ID` | No | - | Key ID of the APNs `.p8` key |
| `APNS_TEAM_ID` | No | - | Apple developer team ID |
| `APNS_KEY` | No | - | The `.p8` private key; `\n` stands for newlines |
| `APNS_TOPIC` | No | - | App bundle id, e.g. `intabia.platform.mobile` |
| `APNS_PRODUCTION` | No | `true` | `false` sends to the APNs sandbox |
| `FCM_SERVICE_ACCOUNT` | No | - | Firebase service-account JSON, verbatim |

Each transport is optional: a subscription whose transport is unconfigured is skipped
rather than failed, so a deployment that only serves browsers needs no new variables.

### Native subscriptions

A native app has no service worker and therefore no Web Push subscription - Apple issues
`web.push.apple.com` endpoints to Safari only, and Android has no equivalent. Both platforms
hand out a device token instead, and it travels in the same `PushSubscription.endpoint`
field under a scheme of its own:

| Endpoint | Transport |
|----------|-----------|
| `apns://<device-token>` | APNs |
| `fcm://<registration-token>` | FCM |
| anything else | Web Push |

Neither the notification model nor the trigger that collects subscriptions knows about the
split: they still pass one list, and the service still resolves the subscriptions that
turned out to be dead and deletes them.

APNs sends an alert push rather than a silent one - waking a sleeping phone is the point,
and `content-available` alone is throttled by iOS. FCM carries a `notification` block, so
Android draws the banner itself while the process is asleep.

### APNs and FCM credentials

The APNs key is created in the Apple developer console (Keys, "Apple Push Notifications
service"), downloaded once as a `.p8` file and never again. A free provisioning profile
carries no push entitlement, so a paid team is required.

The FCM credentials are the service-account JSON from the Firebase console
(Project settings, Service accounts, "Generate new private key"). The legacy server key is
not supported - Google switched it off in 2024.

### VAPID Keys Generation

If you need to generate new VAPID keys, you can run:

```bash
npx web-push generate-vapid-keys
```

## Running the Service

### Development Local Run
```bash
pnpm run run-local
```

### Docker Run
```bash
docker run -d \
  -e SOURCE=no-reply@huly.io \
  -e PUSH_PUBLIC_KEY=your_public_key \
  -e PUSH_PRIVATE_KEY=your_private_key \
  -e QUEUE_CONFIG=redpanda:9092 \
  -e ACCOUNTS_URL=http://account:3000 \
  -e SECRET=secret \
  intabiafusion/notification
```

## Internal Architecture

The consumer listens to `QueueTopic.UserNotifications` for `QueueNotificationMessage` payloads.

When a message is received:
1. It is skipped unless the message lists `PushNotificationProvider` among its providers.
2. Title and body are truncated to `PUSH_NOTIFICATION_TITLE_SIZE` / `PUSH_NOTIFICATION_BODY_SIZE`.
3. Every subscription in `pushSubscriptions` is delivered through the transport its endpoint
   selects: APNs, FCM or `web-push`.
4. A transport that reports the token as gone (HTTP 410, `Unregistered`, `BadDeviceToken`,
   `DeviceTokenNotForTopic`, FCM `UNREGISTERED`/`INVALID_ARGUMENT`, or a `WebPushError` body
   containing `expired`, `Unregistered`, `No such subscription`, `VapidPkHashMismatch`)
   marks that subscription for deletion. Other errors are treated as transient and the
   subscription is kept.
5. For the failed subscriptions the service generates a system token, resolves the
   transactor endpoint and removes the `PushSubscription` documents via `RestClient`.

Processing is wrapped in `withRetry` (3 attempts, exponential backoff 1s → 5s). If all
attempts fail, the message is logged and acknowledged so it does not poison the topic.

### Push payload

The `PushData` delivered to clients:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `title` | string | Yes | Notification title |
| `body` | string | Yes | Notification body text |
| `tag` | string | No | Tag for grouping notifications (the notification id) |
| `domain` | string | No | Workspace domain the notification belongs to |
| `url` | string | No | URL to open when notification is clicked |
| `icon` | string | No | URL to notification icon |

## Testing

Jest is used for unit and integration testing.

Run tests:
```bash
rushx test
```

## Troubleshooting

### Failed subscriptions are not being deleted
- Verify that both `ACCOUNTS_URL` and `SECRET` are set correctly in the service environment.
- Check service logs for "Failed to initialize RestClient or fetch transactor endpoint" or "Failed to remove expired subscription" error messages.

### Nothing is delivered to mobile devices
- APNs needs all of `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_KEY`; FCM needs `FCM_SERVICE_ACCOUNT`.
  When they are missing the matching subscriptions are silently skipped, not failed.
- On a development build the device is registered against the APNs sandbox - set `APNS_PRODUCTION=false`.

### TypeError on bad error bodies
- The service uses safe error parsing to prevent type crashes if `web-push` throws an error with a `null` or `undefined` body. Check that you are using version `0.7.0` or higher which contains this fix.

### Links
- [Web Push Protocol](https://tools.ietf.org/html/rfc8030)
- [VAPID Specification](https://tools.ietf.org/html/rfc8292)
- [Push API MDN Documentation](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Apple Push Notification service](https://developer.apple.com/documentation/usernotifications)
- [Firebase Cloud Messaging HTTP v1](https://firebase.google.com/docs/cloud-messaging/migrate-v1)
