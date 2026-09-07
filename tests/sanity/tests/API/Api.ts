import type { WorkspaceInfoWithStatus, WorkspaceLoginInfo } from '@hcengineering/account'
import { APIRequestContext } from '@playwright/test'
import { DevUrl, LocalUrl, PlatformURI, PlatformWorkspaceRegion } from '../utils'

export class ApiEndpoint {
  private readonly request: APIRequestContext
  private readonly baseUrl: string

  constructor (request: APIRequestContext) {
    this.request = request
    this.baseUrl = typeof DevUrl === 'string' && DevUrl.trim() !== '' ? DevUrl : LocalUrl
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
    const loginUrl = this.baseUrl
    const loginPayload = {
      method: 'login',
      params: { email, password }
    }
    const headers = {
      'Content-Type': 'application/json',
      Origin: PlatformURI,
      Referer: PlatformURI
    }
    const response = await this.request.post(loginUrl, { data: loginPayload, headers })
    if (response.status() !== 200) {
      throw new Error(`Login failed with status: ${response.status()}`)
    }
    const token = (await response.json()).result.token
    return token
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
    const url = this.baseUrl
    const payload = {
      method: 'createWorkspace',
      params: { workspaceName, region: PlatformWorkspaceRegion }
    }
    const headers = this.getDefaultHeaders(token)
    const response = await this.request.post(url, { data: payload, headers })

    const body = await response.json()
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
    // We need to wait for workspace to be created before we will continue.
    const headers = this.getDefaultHeaders(token)
    const url = this.baseUrl
    const selectWorkspaceResponse: WorkspaceLoginInfo = (
      await (
        await this.request.post(url, {
          data: {
            method: 'selectWorkspace',
            params: { workspaceUrl }
          },
          headers
        })
      ).json()
    ).result

    const wsToken = selectWorkspaceResponse.token
    if (wsToken === undefined) {
      throw new Error('Workspace token is undefined')
    }

    const headersInfo = this.getDefaultHeaders(wsToken)
    while (true) {
      const wsInfo: WorkspaceInfoWithStatus = (
        await (
          await this.request.post(url, {
            data: {
              method: 'getWorkspaceInfo',
              params: { updateLastVisit: false }
            },
            headers: headersInfo
          })
        ).json()
      ).result
      if (wsInfo.status.mode === 'active') {
        break
      }
      // 100ms, not 250: a workspace is ready ~500ms after the call, and every test that creates one
      // pays a quarter of a second of pure polling granularity on top.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  async createAccount (email: string, password: string, firstName: string, lastName: string): Promise<any> {
    const url = this.baseUrl
    const payload = {
      method: 'signUp',
      params: { email, password, firstName, lastName }
    }
    const headers = this.getDefaultHeaders()
    const response = await this.request.post(url, { data: payload, headers })
    return await response.json()
  }

  async leaveWorkspace (account: string, username: string, password: string): Promise<any> {
    const token = await this.loginAndGetToken(username, password)
    const url = this.baseUrl
    const payload = {
      method: 'leaveWorkspace',
      params: { account }
    }
    const headers = this.getDefaultHeaders(token)
    const response = await this.request.post(url, { data: payload, headers })
    return await response.json()
  }
}
