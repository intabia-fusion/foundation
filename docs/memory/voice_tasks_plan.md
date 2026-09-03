# FUSIO: Voice-note + AI task creation + Talk To Юля - план

3 фичи. Порядок реализации: **Ф3 -> Ф1 -> Ф2** (каждая опирается на предыдущую).

## Существующая инфра (разведано)

- **STT-провайдеры**: `services/ai-bot/pod-ai-bot/src/transcription/index.ts:62` `createTranscriptionProvider`, `TranscriptionProvider.transcribe` (types.ts:111). Провайдеры: openai/deepgram/server(clisr). ASR-реестр по уровням `transcription/asrRegistry.ts`. НО доступны только через meeting-endpoint `/love/send_raw` (keyed на `workspaceUuid_meetingMinutesId` + LiveKit participant).
- **TranscriptionQueue**: producer `queue.ts:320`, consumer `createTranscriptionsSupport` (transcriptions.ts:31), `TranscriptionConsumer.processTask` (transcription/consumer.ts:257). Task keyed `workspace_participant`.
- **Preview-карточка (паттерн)**: `AIEditProposalMessage extends ThreadMessage` (plugins/ai-bot/src/index.ts:120), model TAIEditProposalMessage (models/ai-bot/src/index.ts:144), presenter через ObjectPresenter mixin (models/ai-bot/src/index.ts:167) -> `EditProposalPresenter.svelte`. Кнопки apply/openDocument. Сервер эмитит: LLM tool `rewrite_document` -> `postEditProposal` (workspaceClient.ts:641) -> addCollection(AIEditProposalMessage).
- **aibot tools**: registry `utils/tools.ts` (registerTool:180, getTools:352). Тул = {type:function, function:{name,description,parameters,parse}} + ToolFunc + contextMode. Есть: load_thread_history, rewrite_document, saveFile/getDataBeforeImport (за DataLabApiKey). НЕТ create-task тула.
- **Issue creation**: нет reusable helper, логика inline в `CreateIssue.svelte:463-529` (client.apply -> $inc sequence -> identifier -> DocData<Issue> -> addCollection). Sub-issue = addCollection в parent.subIssues. Issue class plugins/tracker/src/index.ts:184.
- **Direct с ботом**: `startAIConversation(msg, origin?)` (plugins/ai-bot-resources/src/conversation.ts:66) = ГОТОВЫЙ примитив свежий-чат+первое-сообщение. `getBotAccount()` :40, createAndGetDirect. Bot identity: aiBotAccountEmail='huly.ai.bot@hc.engineering' (plugins/ai-bot/src/index.ts:39), aiBotSocialIdentityStore (utils.ts:20).
- **Chat composer**: input `ChatMessageInput.svelte` (onMessage:201, submit:284) -> AttachmentRefInput (submit:77) -> ReferenceInput.svelte:213 (toolbar actions:216, Send:266). Actions = defaultRefActions (Mention/Emoji, editor/actions.ts) + extraActions + getModelRefActions (RefInputActionItem).
- **Recorder**: `plugins/recorder-resources/src/recorder.ts` MediaRecorder-обёртка (screen/webcam). uploader-resources. НЕТ chat-audio.
- **aibot text-pipeline**: AIQueue -> processEvent (controller.ts:584) -> processMessageEvent (workspaceClient.ts:466) -> generateAndReply (workspaceClient.ts:679). contextMode direct/thread.

## Ф3 - кнопка "Talk To Юля" (MVP: только навигация)

Малый скоуп, переиспользует готовый примитив.
- Кнопка в UI (workbench/sidebar). Действие -> `startAIConversation(undefined)` -> открыть свежий direct с ботом, курсор в input.
- Голосовая запись НЕ здесь - приезжает вторым шагом (Ф3b) после Ф1.
- Файлы: новый компонент кнопки (plugins/ai-bot-resources или workbench), reuse conversation.ts:66.

## Ф1 - voice-note запись + STT + LLM-коррекция + подстановка

Document-driven через новый attachment-тип (решение пользователя, НЕ sync-HTTP).

Поток:
1. **Client**: recorder-resources (расширить audio-only режим) -> запись OGG/WebM-opus. Кнопка в toolbar ReferenceInput:216.
2. **Client**: создать `AudioTranscribe` attachment (новый тип, blob файла + поля: text?, state=pending/done/failed, lang?, targetChat).
3. **aibot client-роль** ловит `TxCreateDoc(AudioTranscribe)` (рядом с ChatMessage-ловлей) -> enqueue TranscriptionTask **нового вида kind=chat-voice** (не meeting-room key).
4. **stt-worker**: берёт файл из blob -> `TranscriptionProvider.transcribe` -> ASR-текст -> **прогон через LLM-коррекцию** (уровень=DefaultLevel/потолок пространства, короткий промпт "исправь ошибки ASR, сохрани смысл+язык") -> `updateDoc(AudioTranscribe, {text, state:done})`.
5. **UI**: liveQuery на AudioTranscribe -> при state=done, если открыт чат с этим аттачментом -> подставить text в ChatMessageInput.

### Recording HUD (live-плашка во время записи, client-side)
Управление: **tap-тоггл** (тап микрофона -> старт, повторный/stop -> стоп). Плашка над input показывает:
- **Таймер mm:ss** - setInterval от старта MediaRecorder (обязательный минимум).
- **Waveform/уровень громкости** - WebAudio AnalyserNode на mic-stream, живая амплитуда (подтверждение что микрофон слышит).
- **Кнопки stop/cancel** - stop=завершить+отправить на транскрибацию (создать AudioTranscribe), cancel=выбросить запись без создания.
- **Статус транскрибации** - после stop: 'transcribing...' спиннер пока aibot обрабатывает (AudioTranscribe.state pending->done). Плашка живёт до подстановки текста в input.
Всё client-side; сервер не нужен для HUD. AnalyserNode на том же getUserMedia stream что MediaRecorder.

Ключевые новые куски:
- Модель: `AudioTranscribe` attachment class (models/attachment или новый), поля text/state(pending/done/failed)/lang.
- Recording HUD-компонент (таймер+waveform+stop/cancel+статус) над ChatMessageInput.
- aibot: расширить transcription-task разбор (сейчас keyed meeting-room -> добавить chat-voice kind, читающий blob напрямую по attachment).
- LLM-коррекция: новый метод в pipeline (не generateAndReply-chat-reply, а транскрипт-коррекция), уровень пространства.
- recorder-resources: audio-only режим + AnalyserNode для waveform.
- billing: ASR usage (durationSeconds) + LLM tokens - как обычно.

Ф3b: после Ф1 - авто-старт записи при открытии чата кнопкой Talk To Юля.

## Ф2 - создание задач ботом + preview-карточка

Переиспользует паттерн AIEditProposalMessage.
- Новый LLM tool `create_task` / `split_task` (utils/tools.ts:registerTool). Параметры: title, description, parent?, subtasks[]. contextMode='any'/'direct'.
- Tool handler НЕ создаёт Issue сразу - постит **новый message class `AITaskProposalMessage extends ThreadMessage`** (по образцу AIEditProposalMessage): поля title, description, subtasks[], targetProject?, created?:boolean.
- Model: TAITaskProposalMessage + ObjectPresenter mixin -> новый presenter `TaskProposalPresenter.svelte` (по образцу EditProposalPresenter). Кнопка "Создать задачу".
- Кнопка apply -> клиентская createIssue-логика (портировать из CreateIssue.svelte:463 в reusable helper: $inc sequence -> identifier -> DocData<Issue> -> addCollection; sub-issue = addCollection в parent.subIssues). Пометить created:true.
- Требует: reusable createIssue helper (сейчас inline только в CreateIssue.svelte).

## Открытые вопросы к реализации
- AudioTranscribe: attachment ли (collection на сообщении) или отдельный doc? Пользователь сказал "новый тип Аттачмента".
- Где хранить blob аудио (chunkStorage как meeting? или обычный attachment blob).
- create_task tool: авто-выбор проекта или спросить у пользователя в карточке.
