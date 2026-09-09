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

// Payment-failed (dunning) email copy — data only, no markup. {param} placeholders are filled
// by the renderer in notifications.ts.
export default {
  ru: {
    subject: 'Не удалось списать оплату по подписке',
    failed: {
      lead: 'Мы не смогли списать оплату по вашей подписке «{plan}». Это могло произойти из-за недостатка средств, истёкшей карты или ограничения банка.',
      note: 'Мы автоматически повторим попытку в ближайшее время.'
    },
    final: {
      lead: 'Мы несколько раз пытались списать оплату по вашей подписке «{plan}», но платёж не прошёл.',
      note: 'Автоматические попытки списания исчерпаны.'
    },
    retryText: 'Вы можете повторить платёж вручную: {url}',
    retryHtmlPrefix: 'Вы можете',
    retryLink: 'повторить платёж вручную',
    contactAdmin: 'При необходимости свяжитесь с администратором ответным письмом.'
  },
  en: {
    subject: 'We could not charge your subscription',
    failed: {
      lead: 'We were unable to charge your subscription "{plan}". This may be due to insufficient funds, an expired card or a bank restriction.',
      note: 'We will automatically retry shortly.'
    },
    final: {
      lead: 'We tried several times to charge your subscription "{plan}", but the payment did not go through.',
      note: 'Automatic retries are now exhausted.'
    },
    retryText: 'You can also retry the payment manually: {url}',
    retryHtmlPrefix: 'You can also',
    retryLink: 'retry the payment manually',
    contactAdmin: 'If you need help, reply to this email to contact the administrator.'
  }
}
