## Desktop Distribution

This package contains the desktop application build configuration and distribution server.

### Automatic updates

All builds are published to Docker registry and can be served via the `intabiafusion/desktop-distro` container.

To check the latest auto-updatable distributions:

* MacOS: `<your-server>/latest-mac.yml`
* Linux: `<your-server>/latest-linux.yml`
* Windows: `<your-server>/latest.yml`

### Docker Container

The `intabiafusion/desktop-distro` Docker image serves all desktop distribution files via HTTP, enabling:

- Desktop app downloads for all platforms (macOS, Windows, Linux)
- Auto-update functionality for Electron apps via `electron-updater`

#### Running the container

```bash
docker run -d -p 8080:8080 intabiafusion/desktop-distro:latest
```

#### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `DIST_DIR` | `/app/dist` | Directory containing distribution files |

#### Available Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check endpoint |
| `GET /api/files` | List all available distribution files with metadata |
| `GET /api/downloads` | Aggregated download manifests (parsed from latest-*.yml / latest-*.yaml). Supports `?refresh=1` to reload manifests on demand. |

Usage example
- Basic request:
```bash
curl -s http://localhost:8080/api/downloads | jq .
```

- Force reload manifests:
```bash
curl -s 'http://localhost:8080/api/downloads?refresh=1' | jq .
```

Example response
```json
{
  "platforms": [
    {
      "platform": "linux",
      "name": "Linux",
      "variants": [
        {
          "manifest": "latest-linux.yml",
          "variant": "x64",
          "version": "0.7.0",
          "releaseDate": "2026-01-18T16:06:02.401Z",
          "artifacts": [
            {
              "filename": "Platform-linux-0.7.0-x86_64.AppImage",
              "url": "/Platform-linux-0.7.0-x86_64.AppImage",
              "size": 218565199,
              "sha512": "...",
              "arch": "x64",
              "archLabel": "Linux - x64"
            }
          ]
        },
        {
          "manifest": "latest-linux-arm64.yml",
          "variant": "arm64",
          "version": "0.7.0",
          "artifacts": [
            {
              "filename": "Platform-linux-0.7.0-arm64.AppImage",
              "url": "/Platform-linux-0.7.0-arm64.AppImage",
              "size": 219259279,
              "sha512": "...",
              "arch": "arm64",
              "archLabel": "Linux - ARM64"
            }
          ]
        }
      ]
    },
    {
      "platform": "mac",
      "name": "macOS",
      "variants": [
        {
          "manifest": "latest-mac.yml",
          "version": "0.7.0",
          "artifacts": [
            {
              "filename": "Platform-macos-0.7.0-x64.zip",
              "url": "/Platform-macos-0.7.0-x64.zip",
              "size": 212924743,
              "sha512": "...",
              "arch": "x64",
              "archLabel": "macOS - Intel"
            },
            {
              "filename": "Platform-macos-0.7.0-arm64.zip",
              "url": "/Platform-macos-0.7.0-arm64.zip",
              "size": 208249487,
              "sha512": "...",
              "arch": "arm64",
              "archLabel": "macOS - Apple Silicon"
            }
          ]
        }
      ]
    }
  ],
  "lastUpdated": "2026-01-18T16:16:18.093Z"
}
```

Notes
- `artifacts[].url` is a relative path usable directly in the UI to construct download links (e.g. `https://your-server.com${artifact.url}`).
- `artifacts[].arch` — machine-readable architecture identifier: `arm64`, `x64`, `x86`, etc.
- `artifacts[].archLabel` — human-friendly platform + architecture description, e.g. `macOS - Apple Silicon`, `macOS - Intel`, `Windows - x64`, `Linux - ARM64`.
- `lastUpdated` shows when the manifests were last scanned by the server.
- `ETag` and `Last-Modified` headers are provided on `GET /api/downloads` responses to enable HTTP caching:
  - `ETag` — a SHA-1 tag representing the current payload. Clients may send `If-None-Match` with this ETag to receive `304 Not Modified` when there are no changes.
  - `Last-Modified` — timestamp of the last scan (HTTP-date). Clients may send `If-Modified-Since`; if the content is not newer, server returns `304 Not Modified`.
- On a conditional request where the resource hasn't changed, the server responds `304 Not Modified` with an empty body. You can also use `HEAD` to fetch headers only.
- You can force re-parse of manifests via `?refresh=1`; after refresh the `ETag` and `Last-Modified` values are updated accordingly.

- Defaults for generic manifests:
  - `latest.yml` (Windows) — interpreted as `x64` by default if no explicit variant is present.
  - `latest-linux.yml` — interpreted as `x64` by default if no explicit variant (e.g. `latest-linux-arm64.yml`) is present.
| `GET /<filename>` | Download specific distribution file |
| `GET /latest.yml` | Windows update manifest |
| `GET /latest-mac.yml` | macOS update manifest |
| `GET /latest-linux.yml` | Linux update manifest |

#### Available Distribution Files

The container includes the following files for each release:

- `Platform-macos-<version>-x64.dmg` - macOS Intel build
- `Platform-macos-<version>-arm64.dmg` - macOS Apple Silicon build
- `Platform-windows-<version>.zip` - Windows portable build
- `Platform-windows-<version>.exe` - Windows installer (NSIS)
- `Platform-linux-<version>.zip` - Linux portable build
- `Platform-linux-<version>.AppImage` - Linux AppImage
- `Platform-linux-<version>.deb` - Debian package
- `*.blockmap` - Delta update files for efficient updates
- `latest*.yml` - Update manifest files for electron-updater

#### Configuring Desktop App for Custom Update Server

To configure the Platform desktop app to use your custom update server, set the update URL before building:

In `package.json` build configuration:
```json
{
  "build": {
    "mac": {
      "publish": {
        "provider": "generic",
        "url": "https://your-server.com"
      }
    },
    "win": {
      "publish": {
        "provider": "generic",
        "url": "https://your-server.com"
      }
    },
    "linux": {
      "publish": {
        "provider": "generic",
        "url": "https://your-server.com"
      }
    }
  }
}
```

#### Docker Compose Example

```yaml
version: '3.8'
services:
  desktop-distro:
    image: intabiafusion/desktop-distro:latest
    ports:
      - "8080:8080"
    restart: unless-stopped
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.desktop.rule=Host(`dist.example.com`)"
      - "traefik.http.services.desktop.loadbalancer.server.port=8080"
```

### Building Locally

```bash
# Install dependencies
pnpm install --frozen-lockfile

# Build the distribution server
cd desktop-package
pnpm run bundle:server

# Build desktop app
pnpm run package
# electron-builder 26 shells out to the package manager named in package.json
# ("packageManager": "pnpm@..."), so pnpm must be on PATH.
pnpm run dist --linux --windows --macos

# Validate the update manifests the build produced
node scripts/verify-manifests.js deploy latest

# Build Docker image locally
docker build -t desktop-distro .
```

### CI/CD

The GitHub Actions workflow automatically:

1. Builds desktop apps for all platforms in the `dist-build` job
2. Creates and pushes the `intabiafusion/desktop-distro` Docker image in the `desktop-distro-build` job

This happens automatically when a version tag (`v*` or `s*`) is pushed.
