# Collaborator Server Testing Guide

## Overview

The `@hcengineering/collaborator` package is a Hocuspocus-based real-time collaboration server using Yjs for document synchronization. It provides WebSocket-based collaborative editing with persistence to platform storage.

## Architecture

### Core Components

1. **Server** (`server.ts`) - Main entry point
   - Express HTTP server with RPC endpoints
   - Hocuspocus WebSocket server for real-time collaboration
   - Statistics endpoint for monitoring

2. **Extensions** (`extensions/`)
   - `authentication.ts` - JWT token validation and workspace verification
   - `storage.ts` - Document persistence with retry logic

3. **Storage** (`storage/`)
   - `adapter.ts` - Interface for storage operations
   - `platform.ts` - Platform storage implementation with MinIO/MongoDB

4. **RPC Methods** (`rpc/methods/`)
   - `getContent.ts` - Retrieve document content
   - `createContent.ts` - Create new collaborative documents
   - `updateContent.ts` - Update existing documents via Yjs updates

5. **Transformers** (`transformers/`)
   - `markup.ts` - Convert between Yjs documents and markup

6. **Platform Integration** (`platform.ts`)
   - Client factories for platform connections
   - Workspace client management

## Testing Strategy

### Unit Tests (Priority: High)

Tests for pure functions and isolated logic:

1. **config.ts** - Configuration parsing from environment variables
2. **context.ts** - Context building from authentication payloads
3. **utils.ts** - Workspace ID resolution
4. **transformers/markup.ts** - Document transformation logic

### Integration Tests (Priority: High)

Tests for RPC methods with mocked dependencies:

1. **rpc/methods/getContent.ts** - Test content retrieval
2. **rpc/methods/createContent.ts** - Test document creation
3. **rpc/methods/updateContent.ts** - Test document updates

### Component Tests (Priority: Medium)

Tests for complex components with mocked external services:

1. **extensions/authentication.ts** - Mock Hocuspocus payloads
2. **extensions/storage.ts** - Mock storage adapter
3. **storage/platform.ts** - Mock storage adapter and client

## Test Setup

### Dependencies to Mock

```typescript
// External services
- @hcengineering/account-client (getAccountClient)
- @hcengineering/server-client (createClient, getTransactorEndpoint)
- @hcengineering/server-token (decodeToken, generateToken)
- @hcengineering/collaboration (saveCollabJson, loadCollabJson, etc.)
- @hcengineering/text-ydoc (markupToYDoc, yDocToMarkup)

// Hocuspocus
- @hocuspocus/server (Hocuspocus, Extension)
- @hocuspocus/transformer (Transformer)
```

### Test Data Patterns

```typescript
// Mock token
const mockToken = {
  account: 'account-uuid',
  workspace: 'workspace-uuid',
  extra: { service: 'collaborator' }
}

// Mock workspace IDs
const mockWorkspaceIds = {
  uuid: 'workspace-uuid',
  dataId: 'workspace-data-id',
  url: 'workspace-url'
}

// Mock document ID
const mockDocumentId = {
  workspaceId: 'workspace-uuid',
  objectId: 'object-id',
  objectClass: 'class:core:Doc',
  objectAttr: 'content'
}
```

## Running Tests

```bash
# Run all tests
cd server/collaborator
pnpm run test

# Run specific test file
pnpm run test -- src/__tests__/config.test.ts

# Run with coverage
pnpm run test -- --coverage
```

## Coverage Goals

- **config.ts**: 100% - All environment variable paths
- **context.ts**: 100% - All context building scenarios
- **utils.ts**: 100% - Workspace ID resolution
- **transformers/markup.ts**: 100% - All transformation cases
- **rpc/methods/**: 90%+ - All RPC methods with error cases
- **extensions/**: 80%+ - Core extension logic
- **storage/**: 80%+ - Storage operations with retry logic

## Common Patterns

### Mocking Hocuspocus

```typescript
const mockHocuspocus = {
  documents: new Map(),
  loadingDocuments: new Map(),
  openDirectConnection: jest.fn()
}
```

### Mocking Storage Adapter

```typescript
const mockStorageAdapter = {
  loadDocument: jest.fn(),
  saveDocument: jest.fn()
}
```

### Mocking MeasureContext

```typescript
const mockCtx = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  with: jest.fn((_, __, fn) => fn(mockCtx)),
  withSync: jest.fn((_, __, fn) => fn()),
  newChild: jest.fn(() => mockCtx)
}
```

## Debugging Tips

1. Use `console.log` with structured objects to trace data flow
2. Mock external dependencies to isolate the code under test
3. Test error paths explicitly (network failures, invalid tokens, etc.)
4. Verify that all mocks are properly reset between tests

## Adding New Tests

When adding new functionality:

1. Create test file in `src/__tests__/` with same relative path as source
2. Follow naming convention: `{source-file}.test.ts`
3. Group related tests in `describe` blocks
4. Use `beforeEach` to reset mocks
5. Test both success and error scenarios
6. Verify mock calls for side effects
