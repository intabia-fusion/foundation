---
name: svelte-component-tests
description: Пишет и чинит компонентные тесты Svelte-компонентов в jsdom через vitest (монтирование компонента, фейковый layout, pointer-события, сторы). Использовать когда просят "покрыть компонент тестами", "тест на Svelte-компонент", "почему onMount не вызывается в тесте", "unit-тест на UI", "настроить vitest в пакете", или когда баг в компоненте нужно зафиксировать тестом вместо ручной проверки в браузере.
---

# Компонентные тесты Svelte в jsdom

Эталон - `packages/ui`: `vitest.config.mts`, `src/__test__/{setup.ts,fakeLayout.ts,Separator.test.ts}`.
Копировать оттуда, а не изобретать заново.

Правило: тест обязан падать без фикса. Проверять откатом фикса, не «на глаз».

## Когда компонентный тест, когда нет

- Арифметика, маппинг, индексы -> вынести в `.ts` рядом с компонентом и покрыть чистыми тестами
  (`separatorLayout.ts` + `separatorLayout.test.ts`). Быстрее, стабильнее, читаемее.
- Жизненный цикл, реакция на смену пропов, подмена DOM-соседей, события мыши/указателя ->
  компонентный тест.
- Переходы между приложениями, реальный сервер, несколько вкладок -> `tests/sanity` (Playwright),
  сюда не тащить.

## Настройка пакета (если vitest ещё нет)

```bash
pnpm --filter @hcengineering/<pkg> add -D vitest@^2 vite@^5 @sveltejs/vite-plugin-svelte@^3 jsdom@^25
```

`vitest.config.mts` (именно `.mts` - плагин ESM-only, из `.ts` не загрузится):

```ts
export default defineConfig({
  plugins: [workspaceSources(), svelte({ hot: false, preprocess: sveltePreprocess() })],
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/__test__/setup.ts'],
    include: ['src/**/*.{test,spec}.ts']
  }
})
```

Скрипты: `"test": "vitest run --silent"` и такой же `"_phase:test"`. Rig видит не-jest `test` и
запускает пакет изолированно через `pnpm run test` - править rig не нужно.

`tsconfig.json` пакета: `"types": []`, иначе профиль rig тянет `types: ["jest"]` и сборка падает на
`TS2688: Cannot find type definition file for 'jest'`.

Импорты в тестах явные - `import { describe, expect, it, vi } from 'vitest'`. Глобалы не включать:
`tsc` их не видит без `types: ["vitest/globals"]`, а этот путь конфликтует с rig.

## Три обязательные подпорки

Без них компонент либо не смонтируется, либо смонтируется наполовину.

**1. `resolve.conditions: ['browser']`.** Без него svelte резолвится в SSR-рантайм: DOM отрисуется,
но `onMount` **не выполнится**. Симптом коварный - компонент вроде живой, а половина состояния
пустая (`parentElement` undefined, обработчики не навешаны, drag ничего не делает).

**2. Плагин `workspaceSources`.** Workspace-пакеты держат `main` на сыром `.ts`, vite такой entry не
принимает: `Failed to resolve entry for package "@hcengineering/theme"`. Плагин резолвит их вручную
(копировать из `packages/ui/vitest.config.mts`).

**3. `src/__test__/setup.ts`.** jsdom не имеет `window.matchMedia` (тянется через plyr из `ui/index`)
и `PointerEvent`. Полифилы - в `packages/ui/src/__test__/setup.ts`.

## Монтирование

Прямой конструктор, без `@testing-library/svelte` - он в зависимостях не нужен:

```ts
const component = new MyComponent({ target: parent, anchor, props: { name, index } })
await new Promise((resolve) => setTimeout(resolve, 20)) // settle: компоненты платформы любят setTimeout
```

`anchor` вставляет компонент **между** существующими детьми - так проверяются компоненты, которым
важны соседи по DOM.

Смена пропа: `component.$set({ color: 'red' })`. Тип пропов выводится из тех, что переданы при
создании: если собираешься менять `color`, передай его в `props` сразу, иначе `TS2353`.

## Фейковый layout

jsdom не считает раскладку - все `getBoundingClientRect()` нулевые, и любой компонент, который меряет
DOM, в тесте бесполезен. `packages/ui/src/__test__/fakeLayout.ts` подменяет rect на прототипе: размер
берётся из inline-стиля, остаток делится между unsized-детьми, offset копится вдоль оси.

```ts
beforeEach(() => { restoreLayout = installFakeLayout(parent) })   // 'vertical' вторым аргументом
afterEach(() => { restoreLayout() })
```

Ловушки, уже отловленные:
- нативный rect хранить **несвязанным**; `.bind(Element.prototype)` восстановит функцию, чей `this`
  прибит к прототипу, и все последующие замеры сломаются;
- второй `installFakeLayout` без restore запомнил бы фейк как «нативный» - функция бросает исключение;
- `data-pinned="57"` на элементе изображает CSS-правило с `!important` (элемент держит свой размер,
  что бы ни выставили инлайном). Так воспроизводится схлопнутый сайдбар.

## Сторы и окружение

- `deviceOptionsStore.fontSize` по умолчанию **0** - вся rem-арифметика схлопнется в ноль. Ставить в
  `beforeEach`: `deviceOptionsStore.update((d) => ({ ...d, fontSize: 16 }))`.
- `localStorage.clear()` и `document.body.innerHTML = ''` в `beforeEach` - состояние протекает между
  тестами.
- Сторы платформы - модульные синглтоны; тест, меняющий стор, обязан вернуть значение обратно.

## События

Pointer-драг целиком синтетический:

```ts
const ev = (type: string, x: number): PointerEvent =>
  new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 10, pointerId: 1 })
separator.dispatchEvent(ev('pointerdown', from))
document.dispatchEvent(ev('pointermove', to))   // слушатели move/up висят на document
document.dispatchEvent(ev('pointerup', to))
```

`offsetX`/`offsetY` в jsdom всегда 0 - компонент, считающий смещение от них, в тесте поведёт себя
иначе, чем в браузере. Это ограничение, а не баг теста.

## Что и как утверждать

Проверять наблюдаемый результат, а не внутренности: inline-стиль, `data-*`, содержимое
`localStorage`, отсутствие исключений во время drag:

```ts
const errors: string[] = []
const onError = (e: ErrorEvent): void => { errors.push(e.message) }
window.addEventListener('error', onError)
drag(separator, 240, 288)
window.removeEventListener('error', onError)
expect(errors).toEqual([])
```

Поведение, которое считаешь неправильным, но не чинишь сейчас, - фиксировать тестом с комментарием
«pinned behaviour, not a desired one» и причиной. Тогда будущий фикс уронит тест, а не пройдёт молча.

## Комбинации вместо копипасты

Для чистых функций - генератор сценариев циклом, проверять инварианты, а не конкретные числа: длина
результата, отсутствие `NaN`/`undefined`, `minSize <= size <= maxSize`. `separatorLayout.test.ts` даёт
~125 кейсов из четырёх вложенных циклов.

Числовые ожидания в точечных тестах брать из просчитанного вручную сценария. Если ожидание не сошлось
- сначала проверить фикстуру (частая ошибка: стартовый размер уже нарушает `minSize`), и только потом
объявлять багом код.

## Бенчмарки

`*.bench.ts` + `"bench": "vitest bench --run"`. В обычный прогон не попадают (`test.include` ловит
только `*.test.ts`). Мерить и чистую функцию на разных размерах, и полный путь через смонтированный
компонент (`Separator.bench.ts` - 60 pointermove).

Порог времени в обычном тесте - только грубый, с запасом в десятки раз, и с пометкой, что это
защита от случайного O(n^2), а точные числа в бенче.

## Проверка перед сдачей

```bash
cd packages/<pkg> && npx vitest run
pnpm -w run build:lint --to @hcengineering/<pkg>
pnpm -w run svelte-check --to @hcengineering/<pkg>
```

Форматтер сам не запускать - `pnpm format` делает пользователь. CI-джоба `formatting` падает именно
на длинных строках в новых тестах.

Находки, которые стоили времени, дописывать в `docs/memory/ui-component-tests-vitest.md`.
