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

// Payer-facing "<action> <plan>" copy for the Init Description — data only. TBank shows it to the
// customer (order description in its email) and it names the fiscal-receipt line (54-ФЗ). The {plan}
// placeholder is filled by the renderer in notifications.ts. Keyed by charge kind, per subscription
// family (tier / package / purchase).
export default {
  ru: {
    tier: {
      purchase: 'Подписка «{plan}»',
      update: 'Изменение подписки «{plan}»',
      renewal: 'Продление подписки «{plan}»',
      retry: 'Оплата подписки «{plan}»'
    },
    package: {
      purchase: 'Пакет «{plan}»',
      update: 'Изменение пакета «{plan}»',
      renewal: 'Продление пакета «{plan}»',
      retry: 'Оплата пакета «{plan}»'
    },
    // One-time catalog item: it is never changed or renewed, so every kind reads the same.
    purchase: {
      purchase: '{plan}',
      update: '{plan}',
      renewal: '{plan}',
      retry: 'Оплата «{plan}»'
    }
  },
  en: {
    tier: {
      purchase: 'Subscription “{plan}”',
      update: 'Subscription change “{plan}”',
      renewal: 'Subscription renewal “{plan}”',
      retry: 'Subscription payment “{plan}”'
    },
    package: {
      purchase: 'Package “{plan}”',
      update: 'Package change “{plan}”',
      renewal: 'Package renewal “{plan}”',
      retry: 'Package payment “{plan}”'
    },
    purchase: {
      purchase: '{plan}',
      update: '{plan}',
      renewal: '{plan}',
      retry: 'Payment for “{plan}”'
    }
  }
}
