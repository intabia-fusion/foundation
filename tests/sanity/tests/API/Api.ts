import type { WorkspaceInfoWithStatus, WorkspaceLoginInfo } from '@hcengineering/account'
import { APIRequestContext } from '@playwright/test'
import { DevUrl, LocalUrl, PlatformURI, PlatformWorkspaceRegion } from '../utils'
import { retry } from '../retry'

export class ApiEndpoint {
  private readonly request: APIRequestContext
  private readonly baseUrl: string

  constructor (request: APIRequestContext) {
    this.request = request
    this.baseUrl = typeof DevUrl === 'string' && DevUrl.trim() !== '' ? DevUrl : LocalUrl
  }

  // An account call can answer with an nginx error page or the SPA index.html, and `json()` then
  // throws "Unexpected token '<'" naming neither the method nor the status.
  private async post (data: { method: string, params: object }, headers: Record<string, string>): Promise<any> {
    const response = await this.request.post(this.baseUrl, { data, headers })
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${data.method} answered ${response.status()} with ${text.slice(0, 120).replace(/\s+/g, ' ')}`)
    }
  }

  private getDefaultHeaders (token: string = ''): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Origin: PlatformURI,
      Referer: PlatformURI
    }
    if (token !== '') {
      headers.Authorization = `Bearer ${token}`
    }
    return headers
  }

  async loginAndGetToken (email: string, password: string): Promise<string> {
    const loginPayload = {
      method: 'login',
      params: { email, password }
    }
    const headers = {
      'Content-Type': 'application/json',
      Origin: PlatformURI,
      Referer: PlatformURI
    }
    const body = await this.post(loginPayload, headers)
    if (body?.result?.token == null) {
      throw new Error(`login failed for ${email}: ${JSON.stringify(body?.error ?? body)}`)
    }
    return body.result.token
  }

  async createWorkspaceWithLogin (
    workspaceName: string,
    username: string,
    password: string
  ): Promise<WorkspaceLoginInfo> {
    const token = await this.loginAndGetToken(username, password)
    return await this.createWorkspaceInternal(workspaceName, token)
  }

  private async createWorkspaceInternal (workspaceName: string, token: string): Promise<WorkspaceLoginInfo> {
    const payload = {
      method: 'createWorkspace',
      params: { workspaceName, region: PlatformWorkspaceRegion }
    }
    const headers = this.getDefaultHeaders(token)
    const body = await this.post(payload, headers)
    // Without this an account-side refusal (WorkspaceLimitReached and friends) surfaces as
    // "Cannot read properties of undefined" from the line below.
    if (body?.result == null) {
      throw new Error(`createWorkspace failed for ${workspaceName}: ${JSON.stringify(body?.error ?? body)}`)
    }
    const wsResult: WorkspaceLoginInfo = body.result

    await this.waitWorkspaceReady(token, wsResult.workspaceUrl)

    return wsResult
  }

  async waitWorkspaceReady (token: string, workspaceUrl: string): Promise<void> {
    // We need to wait for workspace to be created before we continue.
    const headers = this.getDefaultHeaders(token)
    // Retried like the poll below: the call is a read, and a single bad answer used to fail the
    // test in its `beforeEach`.
    let wsToken: string | undefined
    await retry(async () => {
      const selected: WorkspaceLoginInfo = (
        await this.post({ method: 'selectWorkspace', params: { workspaceUrl } }, headers)
      ).result
      wsToken = selected?.token
      if (wsToken === undefined) {
        throw new Error(`selectWorkspace returned no token for ${workspaceUrl}`)
      }
    }, 15000)

    const headersInfo = this.getDefaultHeaders(wsToken)
    // Bounded, and a bad answer only costs one more poll: the read has no side effect, while a
    // single hiccup here used to fail the test in its `beforeEach`.
    const deadline = Date.now() + 60000
    let lastError = 'workspace never became active'
    while (Date.now() < deadline) {
      const wsInfo: WorkspaceInfoWithStatus | undefined = await this.post(
        { method: 'getWorkspaceInfo', params: { updateLastVisit: false } },
        headersInfo
      )
        .then((body) => body?.result)
        .catch((err: Error) => {
          lastError = err.message
          return undefined
        })
      if (wsInfo?.status?.mode === 'active') {
        return
      }
      // 100ms, not 250: a workspace is ready ~500ms after the call, and every test that creates one
      // pays a quarter of a second of pure polling granularity on top.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`workspace ${workspaceUrl} is not ready: ${lastError}`)
  }

  async createAccount (email: string, password: string, firstName: string, lastName: string): Promise<any> {
    const payload = {
      method: 'signUp',
      params: { email, password, firstName, lastName }
    }
    return await this.post(payload, this.getDefaultHeaders())
  }

  async leaveWorkspace (account: string, username: string, password: string): Promise<any> {
    const token = await this.loginAndGetToken(username, password)
    const payload = {
      method: 'leaveWorkspace',
      params: { account }
    }
    return await this.post(payload, this.getDefaultHeaders(token))
  }
}
