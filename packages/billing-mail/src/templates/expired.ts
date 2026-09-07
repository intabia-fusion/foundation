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

// Access-ended copy — data only, no markup. {param} placeholders are filled by the renderer in
// notifications.ts. Sibling of ./upcoming.ts: that one warns before the date, this one confirms
// after it. Keyed by kind (one-off ran out / scheduled cancel took effect), then by subscription
// family (tier/package): a tier drops the workspace to the free plan, a package simply ends.
export default {
  ru: {
    subject: {
      oneoff: {
        tier: 'Доступ по тарифу «{plan}» закончился',
        package: 'Пакет «{plan}» закончился'
      },
      canceled: {
        tier: 'Подписка «{plan}» завершена',
        package: 'Пакет «{plan}» отключён'
      },
      grace: {
        tier: 'Доступ по тарифу «{plan}» приостановлен',
        package: 'Пакет «{plan}» приостановлен'
      },
      trial: {
        tier: 'Пробный период закончился',
        package: 'Пробный период закончился'
      }
    },
    lead: {
      oneoff: {
        tier: 'Оплаченный доступ по тарифу «{plan}» закончился {endDate}.',
        package: 'Оплаченный пакет «{plan}» закончился {endDate}.'
      },
      canceled: {
        tier: 'Подписка «{plan}» завершена {endDate}, как вы и просили.',
        package: 'Пакет «{plan}» отключён {endDate}, как вы и просили.'
      },
      grace: {
        tier: 'Оплата подписки «{plan}» так и не прошла, и {endDate} доступ был приостановлен.',
        package: 'Оплата пакета «{plan}» так и не прошла, и {endDate} он был приостановлен.'
      },
      trial: {
        tier: 'Пробный период тарифа «{plan}» закончился {endDate}.',
        package: 'Пробный период пакета «{plan}» закончился {endDate}.'
      }
    },
    // What is in effect now that the date has passed.
    note: {
      oneoff: {
        tier: 'Рабочее пространство переведено на бесплатный тариф — действуют его ограничения. Данные сохранены: чтобы вернуть прежние возможности, оплатите тариф снова.',
        package: 'Пакет больше не действует. Чтобы продолжить им пользоваться, оплатите его снова.'
      },
      canceled: {
        tier: 'Рабочее пространство переведено на бесплатный тариф — действуют его ограничения. Данные сохранены: чтобы вернуть прежние возможности, оформите подписку снова.',
        package: 'Пакет больше не действует. Чтобы продолжить им пользоваться, оформите его снова.'
      },
      // Grace leaves the subscription in ReadOnly, not on the free plan: data stays visible, editing stops.
      grace: {
        tier: 'Рабочее пространство переведено в режим только для чтения: данные на месте и открыты, но изменить их нельзя. Оплатите подписку, чтобы вернуть полный доступ.',
        package: 'Оплатите пакет, чтобы возобновить работу.'
      },
      trial: {
        tier: 'Рабочее пространство переведено на бесплатный тариф — действуют его ограничения. Данные сохранены: выберите тариф, чтобы вернуть прежние возможности.',
        package: 'Пакет больше не действует. Чтобы продолжить им пользоваться, оплатите его.'
      }
    },
    labels: {
      workspace: 'Рабочее пространство',
      plan: 'Тариф',
      package: 'Пакет',
      amount: 'Стоимость',
      endDate: 'Дата окончания'
    },
    cta: {
      oneoff: 'Продлить доступ',
      canceled: 'Оформить подписку',
      grace: 'Оплатить подписку',
      trial: 'Выбрать тариф'
    }
  },
  en: {
    subject: {
      oneoff: {
        tier: 'Your "{plan}" access has ended',
        package: 'Your "{plan}" package has ended'
      },
      canceled: {
        tier: 'Your "{plan}" subscription has ended',
        package: 'Your "{plan}" package has ended'
      },
      grace: {
        tier: 'Your "{plan}" access is suspended',
        package: 'Your "{plan}" package is suspended'
      },
      trial: {
        tier: 'Your trial has ended',
        package: 'Your trial has ended'
      }
    },
    lead: {
      oneoff: {
        tier: 'Your paid access to the "{plan}" plan ended on {endDate}.',
        package: 'Your "{plan}" package ended on {endDate}.'
      },
      canceled: {
        tier: 'The "{plan}" subscription ended on {endDate}, as you requested.',
        package: 'The "{plan}" package ended on {endDate}, as you requested.'
      },
      grace: {
        tier: 'The payment for the "{plan}" subscription never went through, so access was suspended on {endDate}.',
        package: 'The payment for the "{plan}" package never went through, so it was suspended on {endDate}.'
      },
      trial: {
        tier: 'The trial period of the "{plan}" plan ended on {endDate}.',
        package: 'The trial period of the "{plan}" package ended on {endDate}.'
      }
    },
    note: {
      oneoff: {
        tier: 'The workspace has switched to the free plan and its limits are now in effect. Your data is kept: pay for the plan again to restore the previous capabilities.',
        package: 'The package is no longer active. Pay for it again to keep using it.'
      },
      canceled: {
        tier: 'The workspace has switched to the free plan and its limits are now in effect. Your data is kept: subscribe again to restore the previous capabilities.',
        package: 'The package is no longer active. Subscribe again to keep using it.'
      },
      grace: {
        tier: 'The workspace is now read-only: your data is there and readable, but it cannot be changed. Pay for the subscription to restore full access.',
        package: 'Pay for the package to resume.'
      },
      trial: {
        tier: 'The workspace has switched to the free plan and its limits are now in effect. Your data is kept: choose a plan to restore the previous capabilities.',
        package: 'The package is no longer active. Pay for it to keep using it.'
      }
    },
    labels: {
      workspace: 'Workspace',
      plan: 'Plan',
      package: 'Package',
      amount: 'Price',
      endDate: 'End date'
    },
    cta: {
      oneoff: 'Renew access',
      canceled: 'Subscribe again',
      grace: 'Pay for the subscription',
      trial: 'Choose a plan'
    }
  }
}
