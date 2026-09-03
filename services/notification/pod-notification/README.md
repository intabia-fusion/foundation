# Notification Service

A microservice for sending push notifications: web push to browsers, APNs to iOS and FCM to Android.

## Overview

The notification service is a background worker that consumes user notification messages from Kafka (`user-notifications` topic) and delivers them to subscribed clients via the Web Push Protocol. It uses VAPID (Voluntary Application Server Identification) keys for secure authentication and automatically handles cleanup of expired or unregistered subscriptions.

## Features

- **Web Push Notifications**: Send push notifications to web browsers
- **Native Push**: APNs and FCM delivery for the mobile apps, chosen per subscription
- **VAPID Support**: Secure authentication using VAPID keys
- **Subscription Management**: Handles expired and invalid subscriptions
- **Token Authentication**: Optional bearer token authentication
- **Error Handling**: Automatic cleanup of invalid subscriptions

## Prerequisites

- Node.js (version specified in package.json)
- VAPID key pair for web push authentication
- Valid push subscriptions from client applications

## Configuration

The service is configured via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SOURCE` | Yes | - | Source email or URI identifier for VAPID push payload |
| `SERVICE_ID` | No | `web-push-service` | The identifier of this service used for tracing, queue client IDs, and tokens |
| `PUSH_PUBLIC_KEY` | No | - | VAPID public key for signing push notifications |
| `PUSH_PRIVATE_KEY` | No | - | VAPID private key for signing push notifications |
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
split: they still pass one list, and the service still answers with the subscriptions that
turned out to be dead so the caller can delete them.

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
cross-env SOURCE=no-reply@huly.io QUEUE_CONFIG=localhost:9092 rushx run-local
```

### Docker Run
```bash
docker run -d \
  -e SOURCE=no-reply@huly.io \
  -e PUSH_PUBLIC_KEY=your_public_key \
  -e PUSH_PRIVATE_KEY=your_private_key \
  -e QUEUE_CONFIG=redpanda:9092 \
  -e ACCOUNTS_URL=http://account:3000 \
  -e SERVER_SECRET=secret \
  intabiafusion/notification
```

## Internal Architecture

The consumer listens to `QueueTopic.UserNotifications` for `QueueNotificationMessage` payloads.

When a message is received:
1. It extracts target browser push subscriptions.
2. It sends push payloads via `web-push` library.
3. If an endpoint responds with an expiration error (e.g. `expired`, `Unregistered`, `No such subscription` error body), the service returns the failed subscription ID.
4. The service generates a temporary system token, contacts the transactor via `RestClient`, and removes the failed subscription documents from the database (`TxRemoveDoc`).

## Testing

Jest is used for unit and integration testing.

Run tests:
```bash
npm run test
```

## Troubleshooting

### Failed subscriptions are not being deleted
- Verify that both `ACCOUNTS_URL` and `SERVER_SECRET` (or `SECRET`) are set correctly in the service environment.
- Check service logs for "Failed to initialize RestClient or fetch transactor endpoint" or "Failed to remove expired subscription" error messages.

### TypeError on bad error bodies
- The service uses safe error parsing to prevent type crashes if `web-push` throws an error with a `null` or `undefined` body. Check that you are using version `0.7.0` or higher which contains this fix.

### Links
- [Web Push Protocol](https://tools.ietf.org/html/rfc8030)
- [VAPID Specification](https://tools.ietf.org/html/rfc8292)
- [Push API MDN Documentation](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)