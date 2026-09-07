# Notification Service

A microservice for sending push notifications: web push to browsers, APNs to iOS and FCM to Android.

## Overview

The notification service provides endpoints for sending web push notifications to subscribed clients. It uses the Web Push Protocol with VAPID (Voluntary Application Server Identification) for secure delivery of notifications.

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
| `PORT` | Yes | 8091 | Port number for the service |
| `SOURCE` | Yes | - | Source identifier for the service |
| `AUTH_TOKEN` | No | - | Bearer token for API authentication |
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

### VAPID Keys

To generate VAPID keys, you can use the `web-push` library:

```bash
npx web-push generate-vapid-keys
```

This will output a public and private key pair that should be set in the environment variables.

## Installation

```bash
npm install
```

## Running the Service

### Development
```bash
pnpm run run-local
```

### Docker
```bash
docker build -t notification-service .
docker run -p 8091:8091 \
  -e SOURCE=notification \
  -e PUSH_PUBLIC_KEY=your_public_key \
  -e PUSH_PRIVATE_KEY=your_private_key \
  notification-service
```

## API Endpoints

### POST `/web-push`

Sends web push notifications to subscribed clients.

#### Authentication
- **Header**: `Authorization: Bearer <token>` (if `AUTH_TOKEN` is configured)

#### Request Body
```json
{
  "data": {
    "title": "Notification Title",
    "body": "Notification message",
    "icon": "/icon.png",
    "badge": "/badge.png",
    "tag": "notification-tag",
    "url": "/target-url"
  },
  "subscriptions": [
    {
      "_id": "subscription-id",
      "endpoint": "https://fcm.googleapis.com/fcm/send/...",
      "keys": {
        "p256dh": "client-public-key",
        "auth": "client-auth-secret"
      }
    }
  ]
}
```

#### Response
```json
{
  "result": ["subscription-id-1", "subscription-id-2"]
}
```

The `result` array contains IDs of subscriptions that failed due to:
- Expired subscriptions
- Unregistered subscriptions  
- Invalid subscriptions

These subscription IDs should be removed from your database.

#### Error Responses

- **400 Bad Request**: Missing `data` or `subscriptions` in request body
- **401 Unauthorized**: Invalid or missing auth token (when auth is enabled)
- **500 Internal Server Error**: Server error during processing

## Push Data Format

The `data` object supports the following properties:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `title` | string | Yes | Notification title |
| `body` | string | No | Notification body text |
| `icon` | string | No | URL to notification icon |
| `badge` | string | No | URL to notification badge |
| `tag` | string | No | Tag for grouping notifications |
| `url` | string | No | URL to open when notification is clicked |
| `data` | object | No | Custom data payload |

## Client Integration

### Subscribing to Push Notifications

```javascript
// Register service worker
const registration = await navigator.serviceWorker.register('/sw.js');

// Subscribe to push notifications
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: 'your-vapid-public-key'
});

// Send subscription to your server
await fetch('/api/subscribe', {
  method: 'POST',
  body: JSON.stringify(subscription),
  headers: { 'Content-Type': 'application/json' }
});
```

### Service Worker (sw.js)

```javascript
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  
  const options = {
    body: data.body,
    icon: data.icon,
    badge: data.badge,
    tag: data.tag,
    data: { url: data.url }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  
  if (event.notification.data?.url) {
    event.waitUntil(
      clients.openWindow(event.notification.data.url)
    );
  }
});
```

## Error Handling

The service automatically handles common web push errors:

- **Expired subscriptions**: Automatically identified and returned in response
- **Invalid endpoints**: Subscriptions with invalid endpoints are flagged
- **Unregistered subscriptions**: Previously valid subscriptions that are no longer active

Applications should monitor the response and remove failed subscription IDs from their database.

## Monitoring

The service logs the following events:

- Service startup and VAPID configuration
- Authentication failures
- Push notification errors
- Subscription cleanup events

## Security

- **VAPID Authentication**: All push messages are signed with VAPID keys
- **Token Authentication**: Optional bearer token authentication for API access
- **HTTPS Required**: Web Push Protocol requires HTTPS in production
- **Origin Validation**: Push subscriptions are tied to specific origins

## Development

### Project Structure
```
src/
├── main.ts          # Main application entry point
├── config.ts        # Configuration management
├── server.ts        # Express server setup
└── types.ts         # TypeScript type definitions
```

## Troubleshooting

### Common Issues

1. **"No VAPID keys configured"**
   - Ensure `PUSH_PUBLIC_KEY` and `PUSH_PRIVATE_KEY` are set
   - Verify keys are valid VAPID keys

2. **"Invalid auth token"**
   - Check `AUTH_TOKEN` environment variable
   - Verify bearer token in Authorization header

3. **Push notifications not delivered**
   - Verify subscription is still valid
   - Check browser developer tools for service worker errors
   - Ensure HTTPS is used in production

4. **High subscription failure rate**
   - Check if users are unsubscribing
   - Verify subscription objects are properly formatted
   - Monitor browser console for push registration errors

## Related Documentation

- [Web Push Protocol](https://tools.ietf.org/html/rfc8030)
- [VAPID Specification](https://tools.ietf.org/html/rfc8292)
- [Push API MDN Documentation](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
