---
name: sanity-flakes
description: Ловит и чинит флаки Playwright-набора tests/sanity, разбирает профиль прогона и следит, чтобы каждый следующий прогон был не хуже предыдущего. Использовать когда прислали итог прогона ("1 flaky", "419 passed"), просят "поймай флак", "почему прогон стал дольше", "ускорь тесты", "разбери падение теста".
---

# Sanity: флаки и время прогона

Порядок один и тот же: разобрать -> дойти до корня -> починить в общем месте -> проверить под
нагрузкой -> сравнить время с прошлым прогоном -> записать находку.

Перед началом читать `docs/memory/sanity-flaky-tests.md` - там уже разобранные корни и ловушки.
Туда же дописывать новые.

## 1. Взять факты из прогона

Артефакты лежат в `tests/sanity/runs/<stamp>/`: `run.json`, `playwright-report.json`,
`step-report.ndjson`, `stats.json`, `docker.ndjson`, `report.html`.

Ошибка флакнувшего теста (в терминале её обычно не видно целиком):

```
cd tests/sanity && node -e '
const r=require("./runs/<stamp>/playwright-report.json");
let f=null;function w(s){for(const u of s.suites||[])w(u);for(const sp of s.specs||[])if(sp.title.includes("<кусок названия>"))f=sp}
w(r);
for(const [i,res] of f.tests[0].results.entries()){
 console.log("=== attempt",i,res.status,res.duration+"ms",res.startTime);
 if(res.error)console.log((res.error.message||"").replace(/\x1b\[[0-9;]*m/g,"").split("\n").slice(0,25).join("\n"));
}'
```

Дальше по порядку, пока причина не станет ясна:

- `test-results/<test>/error-context.md` - call log и снимок страницы. Два противоположных диагноза:
  `waiting for <locator>` = контрола не было; `intercepts pointer events` = его накрыли.
- `node analyze_failures.js runs/<stamp>/playwright-report.json` - что упало, что флакнуло.
- `node analyze_steps.js runs/<stamp>/step-report.ndjson` - куда ушло время, таблица нестабильных
  шагов (p50 маленький, max огромный) - это будущие флаки.
- Пошаговая лента конкретного теста:
  `grep "<кусок названия>" runs/<stamp>/step-report.ndjson` и разобрать поля
  `{retry,status,depth,category,title,ms}`.
- Логи сервисов за окно падения. `startTime` в отчёте - UTC, контейнеры тоже пишут UTC, а `date`
  на машине местный: сверять через `date -u`.
  `docker logs --since <ISO>Z --until <ISO>Z sanity-<service>-1`.

Клиентскую причину (кто позвал disconnect, что упало в консоли браузера) видно только в трейсе:
запускать репро с `--trace on` и читать `console`-записи из `trace.trace` внутри `trace.zip`.
JSON-репортер шагов не содержит, а `error-context.md` для таких случаев без снимка.

## 2. Воспроизвести

Флаки почти всегда нагрузочные: в одиночку тест зелёный. Схема - фоновый полный прогон Platform
плюс целевой повтор:

```
# фон, создаёт нагрузку
LOCAL_URL=http://localhost:8083/_account/ DEV_URL= npx playwright test \
  -c ./tests/playwright.config.ts --project=Platform --workers 5 --retries 0 --reporter=line

# целевой повтор
LOCAL_URL=http://localhost:8083/_account/ DEV_URL= npx playwright test \
  -c ./tests/playwright.config.ts --project=Platform <путь к спеке> -g "<название>" \
  --repeat-each 8 --workers 1 --retries 0 --trace on --reporter=line
```

Всё запускать из `tests/sanity`, конфиг - `./tests/playwright.config.ts`.

- `--reporter=line` заменяет список репортеров: не будет ни `step-report.ndjson`, ни
  `playwright-report.json`. Для телеметрии - `pnpm run uitest:telemetry` (это `telemetry/run.sh`,
  аргументы Playwright пробрасываются).
- love-тесты лежат в `*.tests.ts` и в проекте `Love`: путь к файлу даёт `No tests found`, выбирать
  через `--project=Love -g "<часть названия>"`.
- `--repeat-each` на `kanban.spec.ts` даёт ложные падения: view options хранятся на пользователя, а
  storage state общий, и параллельные копии дерутся за раскладку доски.

## 3. Чинить корень, а не симптом

- Правка идёт в общий хелпер (`tests/model/**`, `tests/utils.ts`, `tests/retry.ts`), а не в один
  тест из тикета. Перед правкой - `grep` всех вызывающих.
- Продуктовый баг возможен и обычен: прежде чем подгонять тест, проверить, не прав ли он. В этой
  сессии два флака из трёх оказались дефектами продукта, а не теста.
- Ошибка должна называть виновника. Если падение выглядит как `Unexpected token '<'` или
  `landed on "null"` - сначала добавить в сообщение статус, тело, счётчики; следующий случай
  разберётся сам.
- Опрос и чтение без побочных эффектов - ретраить; запись (signUp, createWorkspace) - нет.
- У любого цикла ожидания должен быть дедлайн: `while (true)` превращается в таймаут теста без
  объяснения.
- Дорогой путь восстановления (`page.reload()`) - только запасной вариант: он умножается на число
  ретраев и растягивает прогон.

## 4. Проверить

1. Целевой тест под нагрузкой, 8 повторов - было/стало (например 4 из 8 падали -> 8 из 8 зелёных).
2. Весь файл спеки целиком - на регресс соседних тестов.
3. `./node_modules/.bin/eslint <файлы>` из `tests/sanity` (источник истины; `prettier` не
   запускать - конфликтует по `member-delimiter-style`).
4. Если правился продукт - `pnpm build:lint --to @hcengineering/<pkg>`; если тесты - `pnpm run build`
   в `tests/sanity`.
5. Время файла спеки до и после: починка не должна стоить прогону минуты.

## 5. Сборка продукта под стенд

Тесты читают TypeScript напрямую - правка в `tests/**` работает сразу, пересборка не нужна.
Правка в `plugins/**`, `packages/**`, `services/**`, `pods/**` попадает на стенд только через образ:

```
pnpm docker --to @hcengineering/pod-front          # соберёт front и его зависимости
cd tests && docker compose -f docker-compose.yaml -p sanity up -d front0 --force-recreate
```

Осторожно, дорогая ошибка: `pnpm docker` перетегивает `latest` у всех собранных образов, а
`docker compose up front0` пересоздаёт и зависимости (account, transactor0, collaborator0). Стенд
становится разноверсионным, и это даёт падения, которых нет ни в одной ветке - в этой сессии так
"сломались" 5 тестов image-reservation через 401 на `/files`. Если владелец стенда сам пересобирает
перед прогоном - не трогать образы вообще; если тронул - вернуть все затронутые контейнеры на один
тег: `DOCKER_TAG=<sha> docker compose -f docker-compose.yaml -p sanity up -d --no-deps <службы> --force-recreate`.

## 6. Следить, чтобы прогон не деградировал

Каждый прогон сравнивать с предыдущим, а не смотреть на абсолютные числа.

```
node telemetry/compare-runs.js runs/<old>/run.json runs/<new>/run.json
```

Разница по файлам (сразу видно, чья починка стоила времени):

```
node -e '
const fs=require("fs");
function totals(dir){const m={};for(const l of fs.readFileSync(dir+"/step-report.ndjson","utf8").trim().split("\n")){const s=JSON.parse(l);if(s.depth!==0)continue;m[s.file]=(m[s.file]||0)+s.ms}return m}
const a=totals("runs/<old>"),b=totals("runs/<new>");
[...new Set([...Object.keys(a),...Object.keys(b)])]
 .map(k=>[k,(b[k]||0)-(a[k]||0),(a[k]||0)/1000,(b[k]||0)/1000])
 .sort((x,y)=>y[1]-x[1]).slice(0,15)
 .forEach(([k,d,p,n])=>console.log((d/1000).toFixed(1).padStart(8),p.toFixed(1).padStart(8),n.toFixed(1).padStart(8)," ",k));'
```

Расписание воркеров - в `run.json`, поле `workers` (`busySec`, `startedSec`, `endedSec`). Если все
заняты почти всё время wall, расписание уже ровное и wall режется только сокращением объёма работы;
если кто-то стартует поздно или простаивает - дело в хвосте длинного файла.

Где искать объём: доля хуков по файлам (setup дороже тел тестов).

```
node -e '
const fs=require("fs");const h={},t={};
for(const l of fs.readFileSync("runs/<stamp>/step-report.ndjson","utf8").trim().split("\n")){
 const s=JSON.parse(l); if(s.depth!==0) continue; t[s.file]=(t[s.file]||0)+s.ms;
 if(s.category==="hook") h[s.file]=(h[s.file]||0)+s.ms }
Object.entries(t).sort((a,b)=>b[1]-a[1]).slice(0,12)
 .forEach(([f,ms])=>console.log((ms/1000).toFixed(1).padStart(7),((h[f]||0)/1000).toFixed(1).padStart(7)," ",f));'
```

Главный рычаг по времени - общий workspace на воркер вместо пересоздания на каждый тест
(`sharedWorkspace` в `tests/fixtures.ts`, разбор в `docs/memory/sanity_shared_workspace.md`).
Учитывать места free-плана: 5 мест, тесты с приглашениями их тратят.

## 7. Записать

Каждая разобранная причина - абзац в `docs/memory/sanity-flaky-tests.md`: что показывал отчёт,
в чём был корень, что изменено, чем проверено. Продуктовые дефекты - ещё и в тематический файл
`docs/memory/<topic>.md` с перекрёстной ссылкой.
