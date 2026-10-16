/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { fireEvent, render, screen } from '@testing-library/react'
import { createInstance } from 'i18next'
import { useForm } from 'react-hook-form'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { describe, expect, test } from 'vitest'

import { Form } from '@/components/ui/form'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { parseQuotaFromDollars } from '@/lib/format'

import { API_KEY_FORM_DEFAULT_VALUES, type ApiKeyFormValues } from '../../lib'
import type { ApiKeySpendUsage } from '../../types'
import { ApiKeySpendLimitSection } from '../api-key-spend-limit-section'

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: {} } },
})

const idleUsage: ApiKeySpendUsage = {
  five_hour_used: 0,
  five_hour_reset: 0,
  daily_used: 0,
  daily_reset: 1_800_000_000,
  weekly_used: 0,
  weekly_reset: 0,
}

function Harness(props: {
  values?: Partial<ApiKeyFormValues>
  usage?: ApiKeySpendUsage
}) {
  const form = useForm<ApiKeyFormValues>({
    defaultValues: { ...API_KEY_FORM_DEFAULT_VALUES, ...props.values },
  })
  return (
    <I18nextProvider i18n={i18n}>
      <Form {...form}>
        <ApiKeySpendLimitSection form={form} usage={props.usage} />
      </Form>
    </I18nextProvider>
  )
}

describe('ApiKeySpendLimitSection', () => {
  test('when the switch is turned on, shows the three window limit inputs', () => {
    render(<Harness />)
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0)

    fireEvent.click(screen.getByRole('switch', { name: 'Enable spend limits' }))

    expect(screen.getByLabelText('5-hour limit (USD)')).toBeTruthy()
    expect(screen.getByLabelText('Daily limit (USD)')).toBeTruthy()
    expect(screen.getByLabelText('7-day limit (USD)')).toBeTruthy()
  })

  test('when usage exceeds the limit, shows full usage and zero remaining', () => {
    const used = parseQuotaFromDollars(15)
    render(
      <Harness
        values={{ spend_limit_enabled: true, spend_limit_daily_amount: 10 }}
        usage={{ ...idleUsage, daily_used: used }}
      />
    )

    expect(
      screen.getByText(
        `Used ${formatQuotaWithCurrency(used)} · Remaining ${formatQuotaWithCurrency(0)}`,
        { exact: false }
      )
    ).toBeTruthy()
  })

  test('when a window has not started, says it starts with the next request', () => {
    render(<Harness values={{ spend_limit_enabled: true }} usage={idleUsage} />)

    expect(screen.getAllByText('Starts with the next request')).toHaveLength(2)
  })
})
