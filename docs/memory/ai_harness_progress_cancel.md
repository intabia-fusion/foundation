# AI harness: прогресс запроса и отмена (17.08.2026)

## Баг: AIRequest никогда не создавался (FUSIO-886, найден 17.08)

`createAIRequest` брал space через `findOne(contact.class.PersonSpace, {account: personUuid})` от
имени бота. PersonSpace **приватный**, `members = [владелец]`, бот-аккаунт (обычный, токен
`generateToken(botPersonUuid, ws, {service:'aibot'})`, не system) его не видит -> findOne = undefined
-> `createAIRequest` тихо возвращал undefined. Проверка на dev-стенде: `select count(*) from ai
where "_class"='ai-bot:class:AIRequest'` = 0 при десятках запросов к боту.

Фикс: AIRequest создаётся в **space самого чата** (тот же, куда бот пишет ответ) — виден и боту, и
юзеру, что и нужно UI прогресса. Ошибка createDoc теперь глушится (warn) — телеметрия не должна
стоить пользователю ответа.

## Транспорт прогресса — AIRequest, а не TypingIndicator

`pulse.TypingIndicator` умеет только `status: IntlString` (без params), поэтому счётчик токенов
через него не пробросить без правки модели pulse. Взяли уже существующий `AIRequest` (DOMAIN_AI,
space чата): добавили `objectId` (чат/тред) + `iteration`, статус `'cancelled'`.
Один док = и прогресс, и канал отмены.

- pod пишет: `WorkspaceClient.requestHooks` (workspaceClient.ts) — update на каждом раунде модели.
- pod читает: `findOne(AIRequest, {_id})` между раундами (RestClient, liveQuery на поде нет).
- UI: `plugins/chunter-resources/src/components/AIRequestProgress.svelte`, liveQuery
  `{objectId, status:'processing'}`, рядом с `ChannelTypingInfo` в `ChatMessageInput`.

## Отмена = переиспользование ветки «кончились итерации»

`runToolCalls` уже имел выход «maxIterations исчерпан -> digest всех tool-результатов ->
`ask(digest, true)` без тулов». Отмена просто делает `break` из цикла ДО выполнения тулов —
дальше та же ветка. Ноль новой логики сборки ответа, требование «за 1 шаг отдать что есть»
выполняется само.

## Все три провайдера на одном цикле (17.08)

`openai.ts` раньше крутил SDK `client.beta.chat.completions.runTools` — свой цикл внутри SDK, hooks
туда не доходили. Переведён на `runToolCalls` через собственный `chatToolStep` (он и так умел
inline tool calls, truncated, retry). **Важно при таком переносе**: биллинг у SDK-пути был один раз
в конце, а `chatToolStep` биллит каждый раунд — финальный `billUsage` надо убрать, иначе двойной
счёт. Очистка `</think>` жила только в SDK-пути, перенесена на итоговый completion.

## Голосовые: где реально висло

Клиент НЕ ждал транскрибацию (HUD `onSend` -> upload -> `dispatch('send')`), но фаза загрузки была
подписана «Распознавание...», что читалось как ожидание ASR. Настоящие зависания:
`asrProvider.transcribe` в `processChatVoice` без таймаута -> `AudioTranscribe` навсегда `pending`
(спиннер в отправленном сообщении вечно). Починено `Promise.race` на 120s -> `state:'failed'`.
Ответ бота ждёт транскрипт до 60s (`VOICE_TRANSCRIPT_WAIT_MS`) и при отсутствии текста подставляет
в промпт пометку о неудачной расшифровке.
