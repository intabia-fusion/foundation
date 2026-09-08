<h1 align="center">
  <img src="./docs/images/logo.png" alt="Интабия Платформа" height="72"><br>
  Интабия Платформа
</h1>

<p align="center">
  Открытая платформа командной работы: задачи, чат, документы, виртуальный офис и ИИ.<br>
  Развитие <a href="https://github.com/hcengineering/platform">hcengineering/platform</a>, которое ведёт Intabia
  вместе с бывшими владельцами и инженерами hcengineering.
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="https://platform.intabia.ru">Сайт</a> ·
  <a href="./docs/getting-started.md">Быстрый старт</a> ·
  <a href="./features.md">Отличия от upstream</a> ·
  <a href="./changelog.md">Список изменений</a>
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/github/license/intabia-fusion/platform?style=flat-square">
  <img alt="Node" src="https://img.shields.io/badge/node-24.x-success?style=flat-square">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-12.x-orange?style=flat-square">
</p>

<p align="center">
  <img src="./docs/images/tracker.png" alt="Трекер" width="860">
</p>

⭐️ Ваша звезда светит нам. Поставьте звезду на GitHub!

## Что внутри

Один репозиторий, одна сборка, набор приложений на общем фреймворке:

| | |
| --- | --- |
| **Трекер** | Задачи, подзадачи, оценки, отчёты по времени, канбан со свимлейнами |
| **Чат** | Каналы и личные сообщения, треды, ответы и пересылка, отметки о прочтении, web push |
| **Документы / QMS** | Совместное редактирование, контролируемая документация, экспорт в markdown |
| **Встречи** | Виртуальный офис и видео на LiveKit, в том числе self-hosted инсталляции |
| **ИИ-бот** | Ассистент поверх Kafka с постоянной памятью, автопротоколы встреч |
| **Планировщик, Диск, HR, Контакты** | Личное планирование, файлы, оргструктура, контакты |
| **Интеграции** | Telegram, Gmail, GitHub, календари, биллинг Stripe, REST + WebSocket API |

<table>
  <tr>
    <td><img src="./docs/images/chat.png" alt="Чат"></td>
    <td><img src="./docs/images/meetings.png" alt="Встречи"></td>
  </tr>
  <tr>
    <td><img src="./docs/images/documents.png" alt="Документы"></td>
    <td><img src="./docs/images/planner.png" alt="Планировщик"></td>
  </tr>
</table>

## Быстрый старт

Нужны [Node.js 24](https://nodejs.org/en/download/), [Docker](https://docs.docker.com/get-docker/)
и Docker Compose.

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm boot            # сборка + сборка Docker-образов + запуск локального стенда
```

Откройте <http://localhost:8087>, нажмите "Sign up" и создайте рабочее пространство.

Короче, с чистого клона:

```bash
sh ./scripts/fast-start.sh
```

Подробности, режим dev-server, watch-сборки и разбор проблем:
[**Getting started**](./docs/getting-started.md).

## Документация

| Документ | Содержание |
| --- | --- |
| [Getting started](./docs/getting-started.md) | Требования, установка, сборка, dev-режим, команды, разбор проблем |
| [Testing](./docs/testing.md) | Юнит-тесты, UI-тесты Playwright, интеграционные стенды |
| [API client](./docs/api-client.md) | npm-пакет `@intabia-fusion/api`, примеры REST и LiveQuery |
| [WSL build guide](./docs/wsl.md) | Сборка на Windows через WSL |
| [Features](./features.md) | Что этот форк меняет относительно upstream Platform |
| [AGENTS.md](./AGENTS.md) | Структура репозитория, стиль кода, процесс сборки, соглашения |
| [docs/](./docs) | Заметки по темам (LLM, встречи, биллинг, регионы, ...) |
| [Changelog](./changelog.md) | Изменения по версиям |

Документация в `docs/` ведётся на английском.

## Версии

Два семейства тегов:

- **`v*`** - production-релизы (`v0.7.310`, `v0.6.501`). Рекомендуются для развёртывания,
  публикуются с описанием на [GitHub Releases](https://github.com/intabia-fusion/platform/releases).
- **`s*`** - сборки для разработки (`s0.7.313`, `s0.7.292`). Только для тестирования, могут
  содержать экспериментальные возможности.

## Self-hosting

Если вас интересует прежде всего self-hosting или переезд с hcengineering Platform без
участия в разработке - подождите, инструкции будут позже.

## Участие в разработке

`develop` - основная ветка, из неё идут production-развёртывания. Изменения попадают туда из
`staging`, когда версия готова для сообщества. Перед первым pull request прочитайте
[AGENTS.md](./AGENTS.md).

## Лицензия

[Eclipse Public License 2.0](./LICENSE).

<sub><sup>&copy; 2025 <a href="https://hardcoreeng.com">Hardcore Engineering Inc</a>. &copy; 2026 Intabia Fusion.</sup></sub>
