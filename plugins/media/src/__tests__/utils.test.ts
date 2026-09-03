//
// Copyright © 2025 Hardcore Engineering Inc.
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

import { cleanupDeviceLabel, getMediaDevices, getSelectedMicId, updateSelectedMicId } from '..'

describe('cleanupDeviceLabel', () => {
  it('removes hardware id suffix', () => {
    expect(cleanupDeviceLabel('FaceTime HD Camera (D288:CE50)')).toEqual('FaceTime HD Camera')
    expect(cleanupDeviceLabel('MacBook Pro Microphone (Built-in)')).toEqual('MacBook Pro Microphone (Built-in)')
    expect(cleanupDeviceLabel('FaceTime HD Camera')).toEqual('FaceTime HD Camera')
  })
})

describe('getMediaDevices', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'mic-a', label: 'Mic A' },
    { kind: 'videoinput', deviceId: 'cam-a', label: 'Cam A' }
  ] as MediaDeviceInfo[]

  beforeEach(() => {
    const store = new Map<string, string>()
    ;(globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k)
    }
    ;(globalThis as any).navigator = {
      permissions: { query: async () => ({ state: 'granted' }) },
      mediaDevices: { enumerateDevices: async () => devices }
    }
  })

  it('keeps the stored device id when that device is not connected', async () => {
    updateSelectedMicId('mic-unplugged')
    const info = await getMediaDevices(true, false)
    expect(info.activeMicrophone?.deviceId).toEqual('mic-a')
    expect(getSelectedMicId()).toEqual('mic-unplugged')
  })

  it('stores the resolved device id when nothing was selected yet', async () => {
    const info = await getMediaDevices(true, false)
    expect(info.activeMicrophone?.deviceId).toEqual('mic-a')
    expect(getSelectedMicId()).toEqual('mic-a')
  })
})
