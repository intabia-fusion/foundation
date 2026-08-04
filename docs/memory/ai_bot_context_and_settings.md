# ЮляИИ: контекст разговоров, настройки, модели (FUSIO-886)

## Контекст по месту (workspaceClient.processMessageEvent)
- **Direct top-level**: бот отвечает inline в Direct (ChatMessage в DirectMessage),
  НЕ тредом. Триггер `server-plugins/ai-bot-resources` -> `getMessageData` (НЕ
  `getDirectThreadData`, тот удалён). Тредовая модель T7 отброшена - неудобно.
- **Граница контекста**: top-level в Space (`event.objectIdIsSpace`=true для
  Direct/Channel, оба extends ChunterSpace) -> только текущий день
  (`modifiedOn >= startOfToday`). Тред (objectIdIsSpace=false) -> весь.
- Tool `load_thread_history(beforeIso, limit)` догружает старше дня
  (`WorkspaceClient.loadThreadHistory`; reqCtx{objectId,objectClass} прокинут через
  getTools 4-м параметром -> ToolFunc).

## КРИТ-БАГ: пустой тред при наличии сообщения в БД
- workspaceClient.ts ~465: было `(event as any).objectIdIsSpace != null ? objectId
  : event.objectSpace`. `objectIdIsSpace` всегда boolean -> `false != null`=true ->
  бот писал ThreadMessage с `space = parentMsg._id` вместо `DirectMessage.space`.
- `channelDataProvider.ts` metadataQuery фильтрует `space: this.space`
  (=parent.space) -> сообщения с чужим space отсеяны -> тред пуст, хотя в БД есть,
  счётчик replies растёт. Фикс: `event.objectIdIsSpace ? objectId : event.objectSpace`.
- Диагностика: сообщения chunter лежат в pg-таблице `activity` (не `chunter` -
  там только ChatSyncInfo); поля `message` внутри `data` json.

## Память всегда в промпте -> get-тулы убраны
- assistantMemory/userMemory/sharedContext инжектятся в prompts.yaml `{{...}}` блоки
  всегда. get_assistant_memory/get_user_memory/get_shared_context УДАЛЕНЫ из
  utils/tools.ts (дублировали промпт). Остались update_*/clear_*.
- Слабые модели (gpt-oss-20b) без серверного tool-parser возвращают function-call
  ТЕКСТОМ (`<|function_call|>{...}`), не нативным tool_calls -> тулы не выполняются,
  юзер видит сырой токен. Лечится на LLM-сервере: vLLM `--enable-auto-tool-choice
  --tool-call-parser`, llama.cpp `--jinja`. НЕ наш код.
- `services/ai-bot/pod-ai-bot/src/utils/openai.ts` - МЁРТВЫЙ файл (0 импортов),
  держит старые hardcoded промпты. Живые промпты - llms/openai.ts + prompts.yaml (T15).

## Реестр моделей по уровням (yaml)
- `services/ai-bot/pod-ai-bot/config.example.yaml` - референс реестра
  (`llm.providers[]`: id/provider/concurrency/batch/levels). Грузится через
  CONFIG_PATH env. НЕ в docker-образе (деплоймент монтирует).
- Dev: `dev/config-aibot.yaml` (server, clisr 2 уровня) +
  `dev/config-aibot-client.yaml` (client, openai 2 модели на host :8000/v1).
  docker-compose: volume mount + CONFIG_PATH для aibot/aibot_client_llm.
- 1 clisr-клиент обслуживает N моделей: выбор по level через свой реестр
  (`resolveModel(level).model.model`). client.ts пробрасывает `request.level` в
  provider-методы (был баг - level игнорировался, всегда defaultLevel).
- config.ts ~394 баг: `yamlConfig?.stt.batch` (точка) -> `?.stt?.batch` - крэш при
  yaml без stt-секции.
- env-интерполяции `${VAR}` в yaml НЕТ - секреты литералами.

## UI настроек ЮляИИ (plugins/ai-bot-resources)
- Одна settings-категория `ai-settings` (role Guest), внутри NavItem-навигация
  Основные/Персональные - паттерн billing Settings.svelte (hulyComponent-content__
  container columns + Separator + location path[5]). НЕ TabList.
- AISettings.svelte (wrapper) -> AISpaceSettingsEditor (Basic, readonly если не
  Owner/Maintainer) + AIPersonalDataSettings (Personal).
- AILevelCards.svelte - компактные чипы (label + ×multiplier, без описаний).
- AILanguageSelector.svelte - переиспользует `ui.string.*` + `ui.metadata.Languages`
  (НЕ love). Auto-опция: DropdownLabelsIntl игнорирует пустой id (`if(result)`),
  поэтому id='auto' маппится '<->' '' на границе.
- Грабли: класс `flex-gap-8` НЕ существует (макс flex-gap-4); `ui` - default-импорт
  не named.

## Сессия FUSIO-886 rebase+фиксы (tbank-integration2)

### paidMultiplier over-limit + downgrade-баг
- config-aibot.yaml low: `paidMultiplier: 0.5` (было 0). Paid low всегда 0.5 (под лимитом+over).
  Free over-limit -> block; paid over-limit -> low доступен (clisr, медленно).
- КРИТ-баг исполнения: `decideLevel` (windowLimit.ts) даунгрейдил requested->low при
  over-limit, но `processMessageEvent` не применял: `llm`(effProvider) + `level` оставались
  исходными -> исполнялся/биллился requested (pro), не low. Фикс: при
  `effectiveLevel!==requestedLevel` перерезолв `llm=providers.get(resolved.provider.id)`,
  передача `effectiveLevel` в createChatCompletionWithTools. `providers` map прокинут
  controller.ts->processMessageEvent.
- `donePatch` (AIRequest.billedTokens) был статичный tokenMultiplier -> теперь plan-aware
  `planMultiplier(resolved.model, plan, hasPackages)`.

### Free не блокировался (resolveWorkspacePlan)
- billing.ts `resolveWorkspacePlan`: было `plan = active?.plan ?? latest?.plan ?? 'free'` ->
  unpaid тир с freeLimits читался по имени как paid -> decideLevel не блокировал free.
  Фикс: `plan = grantingTier?.plan ?? 'free'` (grantsPlan filter). Нет оплаченной/trial -> 'free'.

### LLM error handling (глотание)
- openai.ts/gigachat.ts chatToolStep/createChatCompletionWithTools: `catch->return undefined`
  глотал ECONNREFUSED -> worker возвращал success-undefined -> WS не reject ->
  requestWithFilter (clisr/server.ts) retry не срабатывал -> pod hasResult:false -> тихо.
  Фикс: API-вызов в `withRetry(maxRetries:3, retryNetworkErrors)` (@hcengineering/retry),
  catch -> throw. Pod catch: failedPatch + лог, В ЧАТ НЕ ПИШЕМ, не rethrow. TODO(inbox).

### Промпты (prompts.yaml + prompts.ts + promptStore.ts)
- Имя унифицировано "Юля" (было direct=Юля/thread=ЮляИИ), платформа "Intabia Fusion".
- Добавлено `{{currentDateTime}}` (nowForPrompt локализ) + `Always reply in {{lang}}`.
- Язык ответа: `AIPersonalData.language?` (personal override для direct); резолв
  `resolveChatLanguage` в wsClient (direct: personal->space->ws->default; thread: без personal).
  Протянут `lang` param через LLMProvider interface->openai/gigachat/server/mock->WS request
  (ChatCompletionWithToolsRequest.lang)->client dispatch->buildSystemPrompt. UI:
  AILanguageSelector в AIPersonalDataSettings.svelte.

### Typing "Юля печатает"
- pulse.class.TypingIndicator TTL=3с (models/pulse TransientTTL). Один create протухает.
- `startTyping` (wsClient) через RestClient createDoc/updateDoc, refresh-таймер 2с (<3с),
  возвращает stop(). id `typing:${objectId}:${socialId}`. Обёртка try/finally вокруг
  generateAndReply (вынесен из processMessageEvent). pulse добавлен в deps.

### Юля online (транзактор, sessionManager.ts)
- UserStatus = {online:bool} БЕЗ TTL, side-effect WS-сессии. Юля на REST -> всегда offline.
- Фикс: addSession при `token.extra?.service==='aibot'` -> trySetStatus(online:true).
  close-tick: skip offline для aibot (`isAiBot`). Online пока workspace жив, без пинга.

### Admin set-usage (тест billing по кейсам)
- pod-billing db.setWorkspaceUsed(ws, value, level): DELETE ai_tokens_usage за месяц +
  INSERT total_tokens=value level=<выбран>. endpoint POST /api/v1/admin/:ws/set-used.
  billing-client.setWorkspaceUsed(ws, value, level). UI WorkspaceTokenInfo (в admin
  WorkspaceDetails): EditBox число + DropdownLabels уровень (listAiModelRegistry) + Set/Reset.
- TokenWindows.svelte: `detailed` prop (admin) -> per-level разбивка level:tokens(%);
  compact -> сжатая строка. resetTime -> относительное "через N" (Intl.RelativeTimeFormat).
- LimitsIndicator: 2 полоски (диск+токены/мес, убрана meeting-минуты).
