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

// Internal billing-team service-copy email copy — data only, no markup. Russian-only (team inbox).
// {param} placeholders are filled by the renderer in notifications.ts; markup (<pre>, workspace link)
// stays there.
export default {
  subject: {
    succeeded: '[Биллинг] Успешная оплата: {plan} ({kind})',
    failed: '[Биллинг] Не прошла оплата: {plan} ({reason})',
    receiptBlocked: '[Биллинг][54-ФЗ] Продление заблокировано без чека: {plan} ({code})'
  },
  labels: {
    workspace: 'Воркспейс',
    plan: 'Тариф',
    charged: 'Списано',
    amount: 'Сумма',
    regularPrice: 'Регулярная цена',
    attempt: 'Попытка',
    kind: 'Тип',
    customer: 'Плательщик',
    subscription: 'Подписка',
    cause: 'Причина',
    account: 'Аккаунт'
  },
  // Body blocks for the receipt-blocked (54-ФЗ) team alert (see notifyReceiptBlocked).
  receiptBlocked: {
    lead: 'Продление заблокировано: невозможно выдать фискальный чек (54-ФЗ). Требуется вмешательство.',
    hint: 'Клиенту письмо не отправлено (нет контакта). Добавьте email/телефон плательщику или проверьте интеграцию.'
  },
  // Russian labels for the transaction kind / failure reason enums (used in subject + rows).
  kind: {
    purchase: 'покупка',
    renewal: 'продление'
  },
  reason: {
    failed: 'сбой оплаты',
    final: 'отмена после сбоев'
  },
  // Russian labels for the subscription type enum (SubscriptionType: tier/support/package/purchase).
  type: {
    tier: 'тариф',
    support: 'поддержка',
    package: 'пакет',
    purchase: 'разовая покупка'
  }
}
