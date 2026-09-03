# Проактивная Юля: welcome, авто-резюме митинга (20.08.2026, дайджест снят 21.08)

План и чек-листы - `foundation-tasks/aibot_rework.md` раздел 14. Здесь только неочевидное,
на что наступили.

## Бот был чисто реактивным

Единственный вход - `OnMessageSend`. `getDirect` (`pod-ai-bot/src/utils/platform.ts:37`) лежал
мёртвым кодом с 0 вызовов: Direct с ботом создавался только по кнопке "Talk to Yulia"
(`chunter-resources/src/utils.ts:535`).

## Бот может отсутствовать в пространстве

Цепочка ленивая: `QueueWorkspaceEvent.Up` -> `AIControl.connect` -> `createWorkspaceClient`
-> `tryAssignToWorkspace` -> `ensureEmployee`. Пока pod не получил `Up`, `SocialIdentity` бота
в воркспейсе нет, `getBotAccount()` пуст, и `openBotDirect` **молча выходит** - кнопка есть,
реакции нет. Поэтому welcome сделан двумя путями: триггер (новые) + backfill в `initClient`
(существующие).

## Текст приветствия - welcome.yaml, не i18n

Первый заход делал приветствие триггером `OnEmployeeActivated` в транзакторе и брал текст через
`translate(aiBot.string.WelcomeMessage)`. Тогда же вылезло, что `ai-bot-assets` **не были
зарегистрированы** в `server/server-pipeline/src/internationalization.ts` - `translate()` вернул бы
голый ключ.

Всё это откачено (22.08): текст приветствия - продуктовая строка, её хотят править без пересборки.
Теперь `services/ai-bot/pod-ai-bot/welcome.yaml` (рядом с `prompts.yaml`, тот же приём:
`WELCOME_PATH` env > cwd > корень пакета, `COPY` в Dockerfile). `pickWelcome` даёт fallback
`pt-br` → `pt` → `en`; файла нет - приветствия просто нет, pod не падает.

Раз текст живёт в поде, триггер в транзакторе его не прочитает. Приветствие переехало на
**`QueueTopic.Tx`**: pod подписан батч-консьюмером (группа `ai-bot-welcome`, shared - привет ровно
один), фильтрует `TxMixin` с `mixin === contact.mixin.Employee` и `attributes.active === true`
**до** обращения к клиенту воркспейса (иначе любой tx любого воркспейса поднимал бы pipeline -
та же грабля, что у `isLoveTx` в `services/love/src/main.ts:538`). Идемпотентность - наличие Direct.


## Авто-резюме: три подводных камня

- Хвост STT. `roomFinished` ставит `transcriptionState: Finished`, но чанки ещё в очереди.
  `waitTranscriptSettled` ждёт, пока `MeetingMinutes.transcription` перестанет расти (6×5с).
  Цифры подобраны вслепую - выверить на стенде.
- Держать `LoveQueue`-консьюмер эти полминуты нельзя: стоп для остальных митингов и риск
  rebalance. Первый заход отцеплял вызов через `void` - **не годится**: задача теряется при
  рестарте пода, а суммаризацию собираются усложнять (multi-step). Теперь на `finished`
  публикуется задача в свой топик `ai-summary`, а `startSummary` её разбирает: своя группа
  `ai-bot-summary`, батч 16, `control.heartbeat()` раз в секунду (иначе ожидание хвоста =
  rebalance), `retryTransient` на сетевые, остальное - в dead letter. **Ручная кнопка
  «Суммаризировать» (`POST /summarize`) идёт тем же топиком** с `manual: true` - без ожидания
  хвоста и без гейта настроек, эндпойнт отвечает `202` и ничего не ждёт (клиент ответ и не читал,
  текст пишется в документ через collaborator).
  Консьюмер поднимается только в ролях с `initLLM` (`all`, `llm-router`) - `summarizeMessages`
  без провайдера молча вернёт `undefined`. Топик создаётся в `startSttIngest`, то есть во всех
  ролях, так что продюсер никогда не пишет в несуществующий топик.
- `autoSummarizeMeeting` **не глотает ошибки**: решение о ретрае/dead letter принимает консьюмер.
  Повтор безопасен - `shouldAutoSummarize` отсекает `summary != null`.

Транскрипцию не форсим (решение 20.08): резюме только там, где комната писала транскрипт.
`transcription > 0` это и обеспечивает.
