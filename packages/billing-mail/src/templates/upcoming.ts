//
// Copyright © 2026 Intabia Fusion.
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

// Upcoming-expiry reminder copy — data only, no markup. {param} placeholders are filled by the
// renderer in notifications.ts. Keyed by reminder kind, then by subscription family (tier/package):
// a tier running out drops the workspace to the free plan, a package simply ends, so the two need
// different wording. Trial exists as a tier only.
export default {
  ru: {
    subject: {
      recurrent: 'Скоро спишется оплата по подписке «{plan}»',
      trial: 'Пробный период заканчивается {dueDate}',
      oneoff: 'Доступ по тарифу «{plan}» заканчивается {dueDate}',
      canceled: 'Подписка «{plan}» завершается {dueDate}'
    },
    lead: {
      recurrent: {
        tier: '{dueDate} мы автоматически спишем оплату за следующий период подписки «{plan}».',
        package: '{dueDate} мы автоматически спишем оплату за следующий период пакета «{plan}».'
      },
      trial: {
        tier: 'Пробный период тарифа «{plan}» заканчивается {dueDate}.',
        package: 'Пробный период пакета «{plan}» заканчивается {dueDate}.'
      },
      oneoff: {
        tier: 'Оплаченный доступ по тарифу «{plan}» заканчивается {dueDate}.',
        package: 'Оплаченный пакет «{plan}» заканчивается {dueDate}.'
      },
      canceled: {
        tier: 'Вы отменили подписку «{plan}». Доступ сохранится до {dueDate}.',
        package: 'Вы отменили пакет «{plan}». Он будет доступен до {dueDate}.'
      }
    },
    // What happens once the date passes.
    note: {
      recurrent: 'Если оплата пройдёт успешно, подписка продлится автоматически — ничего делать не нужно.',
      trial: {
        tier: 'После этого рабочее пространство перейдёт на бесплатный тариф, а его ограничения вступят в силу.',
        package: 'После этого пакет перестанет действовать.'
      },
      oneoff: {
        tier: 'Автоматическое продление не подключено: после этой даты рабочее пространство перейдёт на бесплатный тариф.',
        package: 'Автоматическое продление не подключено: после этой даты пакет перестанет действовать.'
      },
      canceled: {
        tier: 'После этой даты рабочее пространство перейдёт на бесплатный тариф.',
        package: 'После этой даты пакет перестанет действовать.'
      }
    },
    labels: {
      workspace: 'Рабочее пространство',
      plan: 'Тариф',
      package: 'Пакет',
      amount: 'Сумма списания',
      dueDate: 'Дата списания',
      endDate: 'Дата окончания',
      paymentMethod: 'Способ оплаты'
    },
    card: 'Карта',
    cta: {
      recurrent: 'Управление подпиской',
      trial: 'Выбрать тариф',
      oneoff: 'Продлить доступ',
      canceled: 'Возобновить подписку'
    },
    support: 'Контакты поддержки'
  },
  en: {
    subject: {
      recurrent: 'Upcoming charge for your "{plan}" subscription',
      trial: 'Your trial ends on {dueDate}',
      oneoff: 'Your "{plan}" access ends on {dueDate}',
      canceled: 'Your "{plan}" subscription ends on {dueDate}'
    },
    lead: {
      recurrent: {
        tier: 'On {dueDate} we will automatically charge you for the next period of the "{plan}" subscription.',
        package: 'On {dueDate} we will automatically charge you for the next period of the "{plan}" package.'
      },
      trial: {
        tier: 'The trial period of the "{plan}" plan ends on {dueDate}.',
        package: 'The trial period of the "{plan}" package ends on {dueDate}.'
      },
      oneoff: {
        tier: 'Your paid access to the "{plan}" plan ends on {dueDate}.',
        package: 'Your "{plan}" package ends on {dueDate}.'
      },
      canceled: {
        tier: 'You canceled the "{plan}" subscription. Access remains until {dueDate}.',
        package: 'You canceled the "{plan}" package. It stays available until {dueDate}.'
      }
    },
    note: {
      recurrent: 'If the payment succeeds, your subscription renews automatically — no action needed.',
      trial: {
        tier: 'After that the workspace switches to the free plan and its limits take effect.',
        package: 'After that the package stops being available.'
      },
      oneoff: {
        tier: 'Auto-renewal is not enabled: after this date the workspace switches to the free plan.',
        package: 'Auto-renewal is not enabled: after this date the package stops being available.'
      },
      canceled: {
        tier: 'After this date the workspace switches to the free plan.',
        package: 'After this date the package stops being available.'
      }
    },
    labels: {
      workspace: 'Workspace',
      plan: 'Plan',
      package: 'Package',
      amount: 'Amount to be charged',
      dueDate: 'Charge date',
      endDate: 'End date',
      paymentMethod: 'Payment method'
    },
    card: 'Card',
    cta: {
      recurrent: 'Manage your subscription',
      trial: 'Choose a plan',
      oneoff: 'Renew access',
      canceled: 'Resume subscription'
    },
    support: 'Support contacts'
  }
}
