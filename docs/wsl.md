# WSL build guide

[← README](../README.md)

Nuances of building and running the application from source code located on an NTFS drive
accessible from both Windows and WSL.

> We recommend storing the repository on a WSL disk instead - it dramatically improves build
> and maintenance operations.

## Prerequisites

### Disk space requirements

- A fully deployed local application in clean Docker consumes slightly more than **35 GB**
  of WSL virtual disk space
- The application folder after a build (sources + artifacts) occupies **4.5 GB**

If there is insufficient space on your system drive (usually `C:\`), change the virtual disk
location in Docker Settings -> Resources -> Advanced.

### Docker WSL integration

1. Go to Docker Settings -> Resources -> Advanced -> WSL Integration
2. Select the distribution where you will be building and running the application
3. Verify the integration works by running this command in WSL:
   ```bash
   docker run hello-world
   ```

## Common issues and solutions

### Git line endings on Windows

Windows Git often replaces line endings automatically. Most build scripts are `.sh` files,
so ensure your Windows checkout does not break them.

Options:

- Check out from WSL instead of Windows
- Disable auto-replacement in Git on Windows (affects all repositories on the machine):
  ```bash
  git config --global core.autocrlf false
  ```

### Elevated privileges in WSL

Some commands require elevated privileges under WSL. On Ubuntu, prefix them with `sudo`:

```bash
sudo corepack enable pnpm
```

### WSL configuration

If the source code is located on a Windows NTFS drive, edit `/etc/wsl.conf` in WSL
(e.g. `sudo nano /etc/wsl.conf`) and add the following if it is not there:

```ini
[automount]
enabled = true
root = /mnt/
options = "metadata,umask=22,fmask=11"

[interop]
appendWindowsPath = false
```

## Running the application

After these preparations, the regular [getting started](./getting-started.md) instructions
work without changes.

### Port conflicts

When starting the application (`pnpm docker:up`), some network ports on Windows might be
occupied. Fix the port mapping in `dev/docker-compose.yaml`.

Depending on which port you change, you will also need to:

1. Find what is using that port
2. Update the new address in the corresponding service configuration
