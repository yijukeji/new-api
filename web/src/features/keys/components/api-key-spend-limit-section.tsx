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
import { Gauge } from 'lucide-react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import {
  SideDrawerSection,
  SideDrawerSectionHeader,
  sideDrawerSwitchItemClassName,
} from '@/components/drawer-layout'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  formatQuotaWithCurrency,
  getCurrencyDisplay,
  getCurrencyLabel,
} from '@/lib/currency'
import { formatTimestampToDate, parseQuotaFromDollars } from '@/lib/format'

import type { ApiKeyFormValues } from '../lib'
import type { ApiKeySpendUsage } from '../types'

type SpendLimitField =
  | 'spend_limit_five_hour_amount'
  | 'spend_limit_daily_amount'
  | 'spend_limit_weekly_amount'

type ApiKeySpendLimitSectionProps = {
  form: UseFormReturn<ApiKeyFormValues>
  usage?: ApiKeySpendUsage
}

export function ApiKeySpendLimitSection(props: ApiKeySpendLimitSectionProps) {
  const { t } = useTranslation()
  const enabled = props.form.watch('spend_limit_enabled')
  const { meta } = getCurrencyDisplay()
  const currency = getCurrencyLabel()
  const windows: {
    name: SpendLimitField
    label: string
    used?: number
    reset?: number
  }[] = [
    {
      name: 'spend_limit_five_hour_amount',
      label: t('5-hour limit ({{currency}})', { currency }),
      used: props.usage?.five_hour_used,
      reset: props.usage?.five_hour_reset,
    },
    {
      name: 'spend_limit_daily_amount',
      label: t('Daily limit ({{currency}})', { currency }),
      used: props.usage?.daily_used,
      reset: props.usage?.daily_reset,
    },
    {
      name: 'spend_limit_weekly_amount',
      label: t('7-day limit ({{currency}})', { currency }),
      used: props.usage?.weekly_used,
      reset: props.usage?.weekly_reset,
    },
  ]

  return (
    <SideDrawerSection>
      <SideDrawerSectionHeader
        title={t('Spend Limits')}
        description={t(
          'Reject new requests once any limit is reached. 0 means no limit.'
        )}
        icon={<Gauge className='size-4' />}
        iconTone='warning'
      />
      <FormField
        control={props.form.control}
        name='spend_limit_enabled'
        render={({ field }) => (
          <FormItem className={sideDrawerSwitchItemClassName()}>
            <div className='flex flex-col gap-0.5'>
              <FormLabel className='text-sm'>
                {t('Enable spend limits')}
              </FormLabel>
              <FormDescription className='text-xs'>
                {t(
                  'Applies together with the key quota and account balance, including unlimited keys'
                )}
              </FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />
      {enabled && (
        <div className='grid gap-4 sm:grid-cols-3'>
          {windows.map((window) => (
            <FormField
              key={window.name}
              control={props.form.control}
              name={window.name}
              render={({ field }) => {
                const limit = parseQuotaFromDollars(field.value || 0)
                return (
                  <FormItem>
                    <FormLabel>{window.label}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type='number'
                        min={0}
                        step={meta.kind === 'tokens' ? 1 : 0.01}
                        onChange={(e) =>
                          field.onChange(Number.parseFloat(e.target.value) || 0)
                        }
                      />
                    </FormControl>
                    {window.used !== undefined && (
                      <FormDescription className='text-xs'>
                        {t('Used {{used}}', {
                          used: formatQuotaWithCurrency(window.used),
                        })}
                        {limit > 0 &&
                          ` · ${t('Remaining {{remaining}}', {
                            remaining: formatQuotaWithCurrency(
                              Math.max(0, limit - window.used)
                            ),
                          })}`}
                        <span className='block'>
                          {window.reset
                            ? t('Resets at {{time}}', {
                                time: formatTimestampToDate(window.reset),
                              })
                            : t('Starts with the next request')}
                        </span>
                      </FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )
              }}
            />
          ))}
        </div>
      )}
    </SideDrawerSection>
  )
}
