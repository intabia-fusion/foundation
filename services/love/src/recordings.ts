import { WorkspaceLoginInfo } from '@hcengineering/account-client'
import { MeasureContext, Ref, WorkspaceIds, WorkspaceUuid } from '@hcengineering/core'
import {
  MeetingMinutes,
  PendingRecording,
  queueEvents,
  QueueMeetingMessage,
  RecordingFormat,
  RecordingState
} from '@hcengineering/love'
import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  WebhookConfig
} from 'livekit-server-sdk'
import { WorkspaceClient } from './workspaceClient'
import { PlatformQueueProducer, StorageConfig } from '@hcengineering/server-core'
import { type LimitsState } from './limits'
import { getS3UploadParams } from './storage'
import { getRecordingPreset } from './preset'
import config from './config'

export type StartRecordingVerdict =
  | { started: true }
  | { started: false, reason: 'already-running' | 'limits-exhausted' | 'no-room' | 'no-reservation' | 'cancelled' }

export type StopRecordingVerdict = { stopped: true } | { stopped: false, reason: 'cooldown' | 'no-room' }

export class RecordingProcessor {
  // A state flip needs to settle before the opposite one is accepted: two people hitting the
  // button at once must not start and stop the same egress within a second.
  private static readonly STATE_FLIP_COOLDOWN_MS = 3000

  // A reservation that never got an egressId belongs to an attempt that died between the two
  // writes; past this age it must not keep blocking new recordings.
  private static readonly RESERVATION_GRACE_MS = 60_000

  // Serialises attempts inside this replica so a double click cannot get past the reservation
  // check. Across replicas the PendingRecording row is the guard, with a one-round-trip window.
  private readonly startInFlight = new Map<Ref<MeetingMinutes>, Promise<StartRecordingVerdict>>()

  constructor (
    readonly ctx: MeasureContext,
    readonly roomClient: RoomServiceClient,
    readonly eventProducer: PlatformQueueProducer<QueueMeetingMessage>,
    readonly egressClient: EgressClient,
    readonly storageConfig: StorageConfig | undefined,
    readonly s3storageConfig: StorageConfig | undefined,
    readonly limitsState?: LimitsState
  ) {}

  async startRecording (
    roomName: string,
    workspaceId: WorkspaceUuid,
    meetingId: Ref<MeetingMinutes>,
    wsLoginInfo: WorkspaceLoginInfo,
    meetingTitle: string
  ): Promise<StartRecordingVerdict> {
    // Wait out an attempt already in flight, then re-run: its reservation is visible by now.
    const inFlight = this.startInFlight.get(meetingId)
    if (inFlight !== undefined) {
      await inFlight.catch(() => undefined)
    }
    const attempt = this.doStartRecording(roomName, workspaceId, meetingId, wsLoginInfo, meetingTitle)
    this.startInFlight.set(meetingId, attempt)
    try {
      return await attempt
    } finally {
      if (this.startInFlight.get(meetingId) === attempt) {
        this.startInFlight.delete(meetingId)
      }
    }
  }

  private async doStartRecording (
    roomName: string,
    workspaceId: WorkspaceUuid,
    meetingId: Ref<MeetingMinutes>,
    wsLoginInfo: WorkspaceLoginInfo,
    meetingTitle: string
  ): Promise<StartRecordingVerdict> {
    // Egress writes straight to S3, past the datalake gate. Skip rather than throw: the queue
    // consumer calls this too, and a throw there means endless redelivery.
    if (this.limitsState?.isExhausted(workspaceId) === true) {
      this.ctx.warn('Cannot start recording: workspace disk/payment limit exhausted', { workspaceId, roomName })
      return { started: false, reason: 'limits-exhausted' }
    }

    // Check if LiveKit room exists before starting recording
    const existingRooms = await this.roomClient.listRooms([roomName])
    if (existingRooms === undefined || existingRooms.length === 0) {
      this.ctx.warn('Cannot start recording: LiveKit room does not exist', { roomName })
      return { started: false, reason: 'no-room' }
    }

    const dateStr = new Date().toISOString().replace('T', '_').slice(0, 19)
    // Use MeetingMinutes title for recording filename

    const wsClient = await WorkspaceClient.create(wsLoginInfo.workspace, this.ctx)
    const meetingDoc = await wsClient.findMeetingById(meetingId)
    if (meetingDoc === undefined) {
      this.ctx.error('Meeting document not found when starting recording', { meetingId })
      throw new Error('Meeting not found')
    }

    const activeVideoRecording = await this.findRunningRecording(wsClient, meetingId, 'video')
    if (activeVideoRecording !== undefined) {
      this.ctx.warn('Video recording already in progress for this meeting', {
        meetingId,
        existingEgressId: activeVideoRecording.egressId,
        status: activeVideoRecording.status
      })
      // The document is what clients read. If it lagged behind the live egress, every press of
      // the (already red) button would keep routing to /startRecord - repair it here.
      if (meetingDoc.recordingState !== RecordingState.Recording) {
        await wsClient.updateMeetingRecordingState(meetingDoc, RecordingState.Recording)
      }
      return { started: false, reason: 'already-running' }
    }

    meetingTitle = meetingTitle.replace(/[^a-zA-Z0-9_-]/g, '_')

    const name = `${meetingTitle}_${dateStr}.mp4`
    const wsIds = {
      uuid: wsLoginInfo.workspace,
      dataId: wsLoginInfo.workspaceDataId,
      url: wsLoginInfo.workspaceUrl
    }

    // Reserve before the slow egress call: this row is the only guard shared across replicas.
    const pendingId = await wsClient.createPendingRecording({ meeting: meetingId, format: 'video', roomName, name })
    if (pendingId === undefined) {
      this.ctx.error('Cannot start recording: failed to reserve PendingRecording', { meetingId, roomName })
      return { started: false, reason: 'no-reservation' }
    }

    let egressId: string
    try {
      egressId = (await this.startRecord(this.ctx, roomName, wsIds, meetingId)).egressId
    } catch (err: any) {
      await wsClient.removePendingRecordingById(pendingId)
      this.ctx.error('Failed to start recording', { error: err?.message ?? String(err), meetingId, roomName })
      throw err
    }

    const statusWhenStarted = await wsClient.setPendingRecordingEgressId(pendingId, egressId)
    if (statusWhenStarted === 'cancelled') {
      // Stop arrived while the egress was coming up - it had no egressId to stop back then.
      this.ctx.info('Recording cancelled while starting, stopping egress', { meetingId, roomName, egressId })
      await this.egressClient.stopEgress(egressId)
      return { started: false, reason: 'cancelled' }
    }

    await wsClient.updateMeetingRecordingState(meetingDoc, RecordingState.Recording)

    this.ctx.info('Start recording', { workspace: wsLoginInfo.workspace, roomName, meetingId })
    return { started: true }
  }

  async stopRecording (
    roomName: string,
    workspaceId: WorkspaceUuid,
    meetingId: Ref<MeetingMinutes>
  ): Promise<StopRecordingVerdict> {
    this.ctx.info('[stopRecording] Called', { roomName, meetingId, workspace: workspaceId })

    // Check if LiveKit room exists before stopping recording
    const existingRooms = await this.roomClient.listRooms([roomName])
    if (existingRooms === undefined || existingRooms.length === 0) {
      this.ctx.warn('[stopRecording] LiveKit room does not exist, skipping stop', { roomName, meetingId })
      return { stopped: false, reason: 'no-room' }
    }

    const wsClient = await WorkspaceClient.create(workspaceId, this.ctx)
    const pending = await wsClient.findPendingRecordingsByMeeting(meetingId)
    const justStarted = pending.find(
      (r) => r.format === 'video' && Date.now() - r.startedAt < RecordingProcessor.STATE_FLIP_COOLDOWN_MS
    )
    if (justStarted !== undefined) {
      this.ctx.warn('[stopRecording] Recording started moments ago, refusing to stop', { roomName, meetingId })
      return { stopped: false, reason: 'cooldown' }
    }

    this.ctx.info('[stopRecording] Room found, stopping video recording', { roomName, meetingId })
    await this.stopRecordingByKind(roomName, workspaceId, meetingId, 'video')
    await this.eventProducer.send(this.ctx, workspaceId, [
      queueEvents.updateMetadata(meetingId, roomName, { recording: false })
    ])
    return { stopped: true }
  }

  async startAudioRecording (
    roomName: string,
    workspaceId: WorkspaceUuid,
    meetingId: Ref<MeetingMinutes>,
    wsLoginInfo: WorkspaceLoginInfo
  ): Promise<void> {
    // Audio (transcription) recording also lands in S3 — same disk/payment gate as video.
    if (this.limitsState?.isExhausted(workspaceId) === true) {
      this.ctx.warn('Cannot start audio recording: workspace disk/payment limit exhausted', {
        workspaceId,
        roomName
      })
      return
    }

    // Check if LiveKit room exists before starting audio recording
    const existingRooms = await this.roomClient.listRooms([roomName])
    if (existingRooms === undefined || existingRooms.length === 0) {
      this.ctx.warn('Cannot start audio recording: LiveKit room does not exist', { roomName })
      return
    }

    if (this.storageConfig === undefined) {
      this.ctx.error('Cannot start audio recording: no storage configuration')
      return
    }

    const wsClient = await WorkspaceClient.create(wsLoginInfo.workspace, this.ctx)
    try {
      const meetingDoc = await wsClient.findMeetingById(meetingId)
      if (meetingDoc === undefined) {
        this.ctx.error('Meeting document not found when starting audio recording', { meetingId })
        return
      }

      const running = await this.findRunningRecording(wsClient, meetingId, 'audio')
      if (running !== undefined) {
        this.ctx.warn('Audio recording already in progress for this meeting', {
          meetingId,
          existingEgressId: running.egressId
        })
        return
      }

      const dateStr = new Date().toISOString().replace('T', '_').slice(0, 19)
      const name = `${meetingDoc.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${dateStr}.ogg`
      // Reserve before the slow egress call - same shared guard the video path uses.
      const pendingId = await wsClient.createPendingRecording({ meeting: meetingId, format: 'audio', roomName, name })
      if (pendingId === undefined) {
        this.ctx.error('Cannot start audio recording: failed to reserve PendingRecording', { meetingId, roomName })
        return
      }

      const wsIds = {
        uuid: wsLoginInfo.workspace,
        dataId: wsLoginInfo.workspaceDataId,
        url: wsLoginInfo.workspaceUrl
      }
      const uploadParams = await getS3UploadParams(this.ctx, wsIds, this.storageConfig, this.s3storageConfig)
      const { filepath, endpoint, accessKey, secret, region, bucket } = uploadParams

      // Replace .mp4 extension with .ogg for audio
      const audioFilepath = filepath.replace(/\.mp4$/, '.ogg')

      this.ctx.info('Starting audio recording', { audioFilepath, endpoint, region, bucket, roomName })

      const output = new EncodedFileOutput({
        fileType: EncodedFileType.OGG,
        filepath: audioFilepath,
        disableManifest: true,
        output: {
          case: 's3',
          value: new S3Upload({
            endpoint,
            accessKey,
            region,
            secret,
            bucket,
            forcePathStyle: true
          })
        }
      })

      let egressId: string
      try {
        egressId = (
          await this.egressClient.startRoomCompositeEgress(
            roomName,
            { file: output },
            {
              audioOnly: true,
              webhooks:
                config.UseEgressWebHook && config.WebHookUrl !== ''
                  ? [
                      new WebhookConfig({
                        url: config.WebHookUrl,
                        signingKey: config.ApiKey
                      })
                    ]
                  : []
            }
          )
        ).egressId
      } catch (err) {
        // Free the slot, otherwise the reservation blocks retries for the whole grace window.
        await wsClient.removePendingRecordingById(pendingId)
        throw err
      }

      const statusWhenStarted = await wsClient.setPendingRecordingEgressId(pendingId, egressId)
      if (statusWhenStarted === 'cancelled') {
        // Transcription was stopped while the egress was coming up, when there was nothing to stop.
        this.ctx.info('Audio recording cancelled while starting, stopping egress', { meetingId, roomName, egressId })
        await this.egressClient.stopEgress(egressId)
        return
      }

      this.ctx.info('Audio recording started', { workspace: workspaceId, roomName, meetingId, egressId })
    } catch (err: any) {
      this.ctx.error('Failed to start audio recording', {
        error: err?.message ?? String(err),
        meetingId,
        roomName
      })
    }
  }

  async stopAudioRecording (
    roomName: string,
    workspaceId: WorkspaceUuid,
    meetingId: Ref<MeetingMinutes>
  ): Promise<void> {
    await this.stopRecordingByKind(roomName, workspaceId, meetingId, 'audio')
  }

  async stopRecordingByKind (
    roomName: string,
    workspaceId: WorkspaceUuid,
    meetingId: Ref<MeetingMinutes>,
    kind: RecordingFormat
  ): Promise<void> {
    const wsClient = await WorkspaceClient.create(workspaceId, this.ctx)
    try {
      // Find audio PendingRecording for this meeting
      const pendingRecordings = await wsClient.findPendingRecordingsByMeeting(meetingId)
      const kindPending = pendingRecordings.filter((r) => r.format === kind)

      for (const pending of kindPending) {
        // Mark as cancelled immediately so UI can show loading state
        await wsClient.cancelPendingRecording(pending)

        if (pending.egressId !== undefined) {
          try {
            await this.egressClient.stopEgress(pending.egressId)
            this.ctx.info(kind + ' recording stopping send', { egressId: pending.egressId })
          } catch (err: any) {
            const errorMsg = err?.message ?? String(err)
            // Egress might already be stopped or completed - this is not an error
            if (
              (typeof errorMsg === 'string' && errorMsg?.includes('EGRESS_COMPLETE')) ||
              (typeof errorMsg === 'string' && errorMsg?.includes('EGRESS_ABORTED')) ||
              (typeof errorMsg === 'string' && errorMsg?.includes('cannot be stopped'))
            ) {
              this.ctx.info(kind + ' recording already stopped or completed', {
                egressId: pending.egressId,
                reason: errorMsg
              })
            } else {
              this.ctx.error('Failed to stop ' + kind + ' egress', {
                error: errorMsg,
                egressId: pending.egressId
              })
            }
          }
        }
      }
    } catch (err: any) {
      this.ctx.error(`Failed to stop ${kind} recording`, {
        error: err?.message ?? String(err),
        meetingId,
        roomName
      })
    }
  }

  /** A row still holding the slot: it has an egress, or it is a fresh reservation. */
  private async findRunningRecording (
    wsClient: WorkspaceClient,
    meetingId: Ref<MeetingMinutes>,
    kind: RecordingFormat
  ): Promise<PendingRecording | undefined> {
    const existing = await wsClient.findPendingRecordingsByMeeting(meetingId)
    return existing.find(
      (r) =>
        r.format === kind &&
        (r.status === 'active' || r.status === 'completed' || r.status == null) &&
        (r.egressId !== undefined || Date.now() - r.startedAt < RecordingProcessor.RESERVATION_GRACE_MS)
    )
  }

  private async startRecord (
    ctx: MeasureContext,
    roomName: string,
    wsIds: WorkspaceIds,
    meetingId: Ref<MeetingMinutes>
  ): Promise<{ filepath: string, egressId: string }> {
    if (this.storageConfig === undefined) {
      console.error('please provide storage configuration')
      throw new Error('please provide storage configuration')
    }
    const uploadParams = await getS3UploadParams(ctx, wsIds, this.storageConfig, this.s3storageConfig)

    const { filepath, endpoint, accessKey, secret, region, bucket } = uploadParams

    ctx.info('staring recording on', { filepath, endpoint, region, bucket })
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath,
      disableManifest: true,
      output: {
        case: 's3',
        value: new S3Upload({
          endpoint,
          accessKey,
          region,
          secret,
          bucket,
          forcePathStyle: true
        })
      }
    })
    const { preset } = getRecordingPreset(config.RecordingPreset)

    const { egressId } = await this.egressClient.startRoomCompositeEgress(
      roomName,
      { file: output },
      {
        layout: 'grid',
        encodingOptions: preset,
        webhooks:
          config.UseEgressWebHook && config.WebHookUrl !== ''
            ? [
                new WebhookConfig({
                  url: config.WebHookUrl,
                  signingKey: config.ApiKey
                })
              ]
            : []
      }
    )
    await this.eventProducer.send(this.ctx, wsIds.uuid, [
      queueEvents.updateMetadata(meetingId, roomName, { recording: true })
    ])
    return { filepath, egressId }
  }
}
