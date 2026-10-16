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
import type { TFunction } from 'i18next'
import { describe, expect, test } from 'vitest'

import { parseQuotaFromDollars } from '@/lib/format'

import type { ApiKey } from '../../types'
import {
  API_KEY_FORM_DEFAULT_VALUES,
  getApiKeyFormSchema,
  transformApiKeyToFormDefaults,
  transformFormDataToPayload,
} from '../api-key-form'

const t = ((key: string) => key) as TFunction

const legacyApiKey: ApiKey = {
  id: 1,
  name: 'test',
  key: 'sk-test',
  status: 1,
  remain_quota: 0,
  used_quota: 0,
  unlimited_quota: true,
  expired_time: -1,
  created_time: 1,
  accessed_time: 0,
  group: 'default',
  auto_groups: null,
  cross_group_retry: false,
  model_limits_enabled: false,
  model_limits: '',
  allow_ips: '',
  allow_user_quota_query: false,
}

describe('API key spend limit form mapping', () => {
  test('converts entered limit amounts to quota units in the payload', () => {
    const payload = transformFormDataToPayload({
      ...API_KEY_FORM_DEFAULT_VALUES,
      spend_limit_enabled: true,
      spend_limit_five_hour_amount: 1.5,
      spend_limit_daily_amount: 0,
      spend_limit_weekly_amount: 20,
    })

    expect(payload.spend_limit_enabled).toBe(true)
    expect(payload.spend_limit_five_hour).toBe(parseQuotaFromDollars(1.5))
    expect(payload.spend_limit_daily).toBe(0)
    expect(payload.spend_limit_weekly).toBe(parseQuotaFromDollars(20))
  })

  test('maps a response without spend limit fields to disabled zero limits', () => {
    const values = transformApiKeyToFormDefaults(legacyApiKey)

    expect(values.spend_limit_enabled).toBe(false)
    expect(values.spend_limit_five_hour_amount).toBe(0)
    expect(values.spend_limit_daily_amount).toBe(0)
    expect(values.spend_limit_weekly_amount).toBe(0)
  })

  test('round-trips stored limits back into the same payload quota', () => {
    const quota = parseQuotaFromDollars(12.34)
    const values = transformApiKeyToFormDefaults({
      ...legacyApiKey,
      spend_limit_enabled: true,
      spend_limit_daily: quota,
    })

    expect(transformFormDataToPayload(values).spend_limit_daily).toBe(quota)
  })

  test('rejects a negative limit amount', () => {
    const result = getApiKeyFormSchema(t).safeParse({
      ...API_KEY_FORM_DEFAULT_VALUES,
      name: 'test',
      spend_limit_weekly_amount: -1,
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ['spend_limit_weekly_amount'],
    ])
  })
})
