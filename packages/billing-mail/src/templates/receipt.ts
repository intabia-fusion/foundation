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

// Receipt (successful-payment) email copy — data only, no markup. {param} placeholders are filled
// by the renderer in notifications.ts. Field labels are shared across purchase/renewal.
export default {
  ru: {
    subject: 'Чек об оплате — {plan} от {paidAtDate}',
    intro: {
      purchase: {
        tier: 'Оплата тарифа «{plan}» прошла успешно.',
        package: 'Оплата пакета «{plan}» прошла успешно.',
        purchase: 'Оплата «{plan}» прошла успешно.'
      },
      renewal: {
        tier: 'Подписка «{plan}» успешно продлена.',
        package: 'Пакет «{plan}» успешно продлён.',
        // A one-time purchase never renews; kept only so the shape matches.
        purchase: 'Оплата «{plan}» прошла успешно.'
      }
    },
    labels: {
      customer: 'Плательщик',
      plan: 'Тариф',
      package: 'Пакет',
      purchase: 'Покупка',
      amount: {
        purchase: 'Сумма',
        renewal: 'Сумма списания'
      },
      paidAt: 'Дата и время оплаты',
      txId: 'ID транзакции',
      paymentMethod: 'Способ оплаты',
      period: 'Период подписки'
    },
    card: 'Карта',
    manageLink: 'Управление подпиской',
    support: 'Контакты поддержки'
  },
  en: {
    subject: 'Payment receipt — {plan} from {paidAtDate}',
    intro: {
      purchase: {
        tier: 'Your payment for the "{plan}" plan was successful.',
        package: 'Your payment for the "{plan}" package was successful.',
        purchase: 'Your payment for "{plan}" was successful.'
      },
      renewal: {
        tier: 'Your "{plan}" subscription was renewed successfully.',
        package: 'Your "{plan}" package was renewed successfully.',
        purchase: 'Your payment for "{plan}" was successful.'
      }
    },
    labels: {
      customer: 'Customer',
      plan: 'Plan',
      package: 'Package',
      purchase: 'Purchase',
      amount: {
        purchase: 'Amount',
        renewal: 'Amount charged'
      },
      paidAt: 'Payment date and time',
      txId: 'Transaction ID',
      paymentMethod: 'Payment method',
      period: 'Subscription period'
    },
    card: 'Card',
    manageLink: 'Manage your subscription',
    support: 'Support contacts'
  }
}
