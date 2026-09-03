# Кнопка записи залипает: /startRecord -> 409 already-running

Подтверждено логами stage `love-service-599d9797-cp5sz.log` (2026-09-01, meeting
`6a96c591705d15e7270663de`). Пользователь остановил транскрипцию раньше видеозаписи.

```
12:31:24.894  createPendingRecording  format:video
12:31:24.959  egress_started          EG_Wo2BZtRutmMK   <- видео
12:31:25.047  updateMeetingRecordingState  state:1 (Recording)
12:31:31.618  cancelPendingRecording  format:audio  EG_VhKAuqdee5V9
12:31:31.824  egress_ended            EG_VhKAuqdee5V9   <- АУДИО
12:31:31.857  updateMeetingRecordingState  state:2 (Finished)  <- сбросил флаг видео
12:31:34.587  warn: Video recording already in progress  EG_Wo2BZtRutmMK
```

## Первопричина

`services/love/src/webhook.ts` `egressEnded` сбрасывал `recordingState` в `Finished`
для egress **любого формата**. Аудио-egress (транскрипция, `.ogg`) живёт своей жизнью
и заканчивается раньше видео. Старт разделён по форматам корректно
(`startAudioRecording` трогает только `transcriptionState`), а конец - нет.

## Почему кнопка после этого залипала намертво

Два разных критерия «идёт ли запись»:

- `RecordingButton.svelte` рисовал красную кнопку по `currentVideoRecording !== undefined ||
  recordingState === Recording` - живой `PendingRecording` достаточно
- `loveClient.record` выбирал `/startRecord` vs `/stopRecord` только по `recordingState`

`PendingRecording` видео жив, флаг сброшен -> кнопка красная, каждое нажатие уходит в
`/startRecord` -> 409 `already-running`.

## Фиксы

1. `webhook.ts` - сбрасывать `recordingState` только для `format === 'video'`.
2. `loveClient.record(mm, isRecording)` - путь решает вызывающий; `RecordingButton`
   передаёт тот же признак, по которому рисует себя.
3. `recordings.ts` `startRecording` - на `already-running` чинит отставший документ
   (`updateMeetingRecordingState` глотает ошибки в catch, рассинхрон возможен и иначе).

## Про существующий тест

`recordings.test.ts` «reports a refusal when a recording is already running» проверял,
что сервер **возвращает** `already-running` - то есть фиксировал симптом как корректное
поведение. Клиентский рассинхрон не покрывал никто.
