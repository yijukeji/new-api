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
import { useQuery } from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'

import { getCodexUsage } from '../api'
import { isTagAggregateRow } from '../lib/channel-utils'
import {
  getWindowResetAt,
  getWindowUsage,
  resolveRateLimitWindows,
  type CodexRateLimitWindow,
  type RateLimitSource,
} from '../lib/codex-usage'
import type { Channel } from '../types'
import { useChannels } from './channels-provider'

export function SessionUsageCell(props: { channel: Channel }) {
  const { sensitiveVisible } = useChannels()
  if (!sensitiveVisible) {
    return <span className='text-muted-foreground'>••••</span>
  }
  if (props.channel.type !== 57 || isTagAggregateRow(props.channel)) {
    return <span className='text-muted-foreground'>-</span>
  }
  return <CodexSessionUsage channel={props.channel} />
}

function CodexSessionUsage(props: { channel: Channel }) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['channels', 'codex-usage', props.channel.id],
    queryFn: async () =>
      requireServerSuccess(await getCodexUsage(props.channel.id)).data,
    enabled: !props.channel.channel_info?.is_multi_key,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    meta: { errorToast: false },
  })
  const windows = resolveRateLimitWindows(
    (query.data ?? null) as RateLimitSource | null
  )
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  if (props.channel.channel_info?.is_multi_key) {
    return (
      <span className='text-muted-foreground text-xs'>
        {t('Not supported')}
      </span>
    )
  }
  return (
    <div className='flex w-56 max-w-full items-start gap-1 py-1'>
      <div className='min-w-0 flex-1 space-y-2' aria-live='polite'>
        {windows.fiveHourWindow && (
          <SessionWindow
            label='5h'
            window={windows.fiveHourWindow}
            fetchedAt={query.dataUpdatedAt}
            now={now}
          />
        )}
        {windows.weeklyWindow && (
          <SessionWindow
            label='7d'
            window={windows.weeklyWindow}
            fetchedAt={query.dataUpdatedAt}
            now={now}
          />
        )}
        {!windows.fiveHourWindow && !windows.weeklyWindow && (
          <span className='text-muted-foreground text-xs'>
            {query.isPending ? t('Loading...') : t('Usage unavailable')}
          </span>
        )}
        {query.isError && (
          <span className='text-destructive text-xs'>
            {t('Refresh failed')}
          </span>
        )}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label={t('Refresh usage')}
              disabled={query.isFetching}
              onClick={(event) => {
                event.stopPropagation()
                void query.refetch()
              }}
            />
          }
        >
          {query.isFetching ? (
            <Loader2 className='size-3 animate-spin' />
          ) : (
            <RefreshCw className='size-3' />
          )}
        </TooltipTrigger>
        <TooltipContent>{t('Refresh usage')}</TooltipContent>
      </Tooltip>
    </div>
  )
}

function SessionWindow(props: {
  label: string
  window: CodexRateLimitWindow
  fetchedAt: number
  now: number
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const usage = getWindowUsage(props.window)
  const resetAt = getWindowResetAt(props.window, props.fetchedAt)
  const minutes =
    resetAt === null
      ? null
      : Math.max(0, Math.ceil((resetAt - props.now / 1000) / 60))
  let countdown = '-'
  if (minutes !== null) {
    if (minutes === 0) countdown = t('Reset due')
    else {
      countdown = t('{{hours}}h {{minutes}}m', {
        hours: Math.floor(minutes / 60),
        minutes: minutes % 60,
      })
    }
  }
  const used =
    usage.used === null ? '-' : `${formatNumber(usage.used, locale)}%`
  const remaining =
    usage.remaining === null ? '-' : `${formatNumber(usage.remaining, locale)}%`
  return (
    <div className='space-y-1'>
      <div className='flex items-center gap-2 text-xs tabular-nums'>
        <span className='bg-muted shrink-0 rounded px-1.5 py-0.5 font-medium'>
          {props.label}
        </span>
        <Progress
          value={usage.used}
          aria-label={`${props.label} ${t('Used:')} ${used}`}
          className={`min-w-8 flex-1 ${usage.used !== null && usage.used >= 90 ? '[&_[data-slot=progress-indicator]]:bg-destructive' : '[&_[data-slot=progress-indicator]]:bg-success'}`}
        />
        <span className='w-12 shrink-0 text-right'>{used}</span>
      </div>
      <div className='text-muted-foreground flex flex-wrap justify-between gap-x-2 text-[11px] tabular-nums'>
        <span>
          {t('Remaining:')} {remaining}
        </span>
        <span>{t('Resets in {{duration}}', { duration: countdown })}</span>
      </div>
    </div>
  )
}
