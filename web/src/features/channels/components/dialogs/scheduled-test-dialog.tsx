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
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Clock, Loader2, Save, XCircle } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { toIntlLocale } from '@/i18n/languages'
import {
  ADMIN_PERMISSION_ACTIONS,
  ADMIN_PERMISSION_RESOURCES,
  hasPermission,
} from '@/lib/admin-permissions'
import { formatNumber, formatTimestampToDate } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { useAuthStore } from '@/stores/auth-store'

import {
  getChannelScheduledTest,
  saveChannelScheduledTest,
  type ScheduledTestData,
} from '../../api'
import { parseModelsList } from '../../lib/channel-utils'
import type { Channel } from '../../types'

const scheduleSchema = z.object({
  enabled: z.boolean(),
  cron: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((value) => value.split(/\s+/).length === 5),
  timezone: z.string().min(1).max(128),
  model: z.string().max(255),
})
type ScheduleValues = z.infer<typeof scheduleSchema>

const presets = [
  { label: 'Daily at 08:00', cron: '0 8 * * *' },
  { label: 'Daily at 12:00', cron: '0 12 * * *' },
  { label: 'Daily at 18:00', cron: '0 18 * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every 12 hours', cron: '0 */12 * * *' },
  { label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' },
] as const

export function ScheduledTestDialog(props: {
  channel: Channel
  onClose: () => void
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['channels', 'scheduled-test', props.channel.id],
    queryFn: () => getChannelScheduledTest(props.channel.id),
    refetchInterval: 10_000,
    meta: { errorToast: false },
  })
  if (query.data) {
    return (
      <ScheduledTestConfiguration
        channel={props.channel}
        data={query.data}
        onClose={props.onClose}
      />
    )
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={t('Scheduled test')}
      description={props.channel.name}
    >
      {query.isError ? (
        <ErrorState
          onRetry={() => {
            void query.refetch()
          }}
        />
      ) : (
        <LoadingState />
      )}
    </Dialog>
  )
}

function ScheduledTestConfiguration(props: {
  channel: Channel
  data: ScheduledTestData
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const queryClient = useQueryClient()
  const currentUser = useAuthStore((state) => state.auth.user)
  const canOperate = hasPermission(
    currentUser,
    ADMIN_PERMISSION_RESOURCES.CHANNEL,
    ADMIN_PERMISSION_ACTIONS.OPERATE
  )
  const form = useForm<ScheduleValues>({
    resolver: zodResolver(scheduleSchema),
    defaultValues: props.data.schedule,
  })
  const enabled = form.watch('enabled')
  const mutation = useMutation({
    mutationFn: (values: ScheduleValues) =>
      saveChannelScheduledTest(props.channel.id, values),
    onSuccess: () => {
      toast.success(t('Saved successfully'))
      void queryClient.invalidateQueries({
        queryKey: ['channels', 'scheduled-test', props.channel.id],
      })
      props.onClose()
    },
    onError: (error) => handleServerError(error),
  })
  const locked = mutation.isPending || !canOperate
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) props.onClose()
      }}
      title={
        <span className='flex items-center gap-2'>
          <Clock className='size-5' />
          {t('Scheduled test')}
        </span>
      }
      description={props.channel.name}
      bodyClassName='space-y-5'
      footer={
        <>
          <Button
            variant='outline'
            onClick={props.onClose}
            disabled={mutation.isPending}
          >
            {t('Cancel')}
          </Button>
          <Button
            type='submit'
            form='channel-scheduled-test-form'
            disabled={locked}
          >
            {mutation.isPending ? (
              <Loader2 className='size-4 animate-spin' />
            ) : (
              <Save className='size-4' />
            )}
            {t('Save configuration')}
          </Button>
        </>
      }
    >
      <form
        id='channel-scheduled-test-form'
        className='space-y-5'
        onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
      >
        <div className='flex items-center justify-between gap-3'>
          <Label htmlFor='schedule-enabled'>{t('Enable scheduled test')}</Label>
          <Switch
            id='schedule-enabled'
            checked={enabled}
            onCheckedChange={(checked) =>
              form.setValue('enabled', checked, { shouldDirty: true })
            }
            disabled={locked}
          />
        </div>
        <div className='space-y-2'>
          <Label htmlFor='schedule-cron'>{t('Cron expression')}</Label>
          <Input
            id='schedule-cron'
            {...form.register('cron')}
            disabled={locked || !enabled}
            aria-invalid={!!form.formState.errors.cron}
          />
          {form.formState.errors.cron && (
            <p role='alert' className='text-destructive text-xs'>
              {t('Invalid cron expression')}
            </p>
          )}
        </div>
        <div className='space-y-2'>
          <Label>{t('Quick settings')}</Label>
          <div className='flex flex-wrap gap-2'>
            {presets.map((preset) => (
              <Button
                key={preset.cron}
                type='button'
                variant='outline'
                size='sm'
                disabled={locked || !enabled}
                onClick={() =>
                  form.setValue('cron', preset.cron, { shouldDirty: true })
                }
              >
                {t(preset.label)}
              </Button>
            ))}
          </div>
        </div>
        <div className='space-y-2'>
          <Label htmlFor='schedule-timezone'>{t('Timezone')}</Label>
          <Input
            id='schedule-timezone'
            {...form.register('timezone')}
            disabled={locked || !enabled}
            aria-invalid={!!form.formState.errors.timezone}
          />
          {form.formState.errors.timezone && (
            <p role='alert' className='text-destructive text-xs'>
              {t('Invalid timezone')}
            </p>
          )}
        </div>
        <div className='space-y-2'>
          <Label htmlFor='schedule-model'>{t('Test model')}</Label>
          <NativeSelect
            id='schedule-model'
            className='w-full'
            {...form.register('model')}
            disabled={locked || !enabled}
          >
            <NativeSelectOption value=''>
              {t('Default test model')}
            </NativeSelectOption>
            {parseModelsList(props.channel.models).map((model) => (
              <NativeSelectOption key={model} value={model}>
                {model}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </form>
      {props.data.schedule.next_run > 0 && (
        <p className='text-muted-foreground text-xs'>
          {t('Next test')}:{' '}
          {formatTimestampToDate(props.data.schedule.next_run)}
        </p>
      )}
      <section className='space-y-2' aria-label={t('Recent test records')}>
        <h3 className='text-sm font-medium'>{t('Recent test records')}</h3>
        {props.data.history.length === 0 ? (
          <EmptyState title={t('No test records')} className='min-h-24 py-4' />
        ) : (
          <ul className='divide-y'>
            {props.data.history.map((record) => (
              <li
                key={record.time}
                className='flex items-center gap-2 py-2 text-sm tabular-nums'
              >
                {record.success ? (
                  <CheckCircle2
                    className='text-success size-4 shrink-0'
                    aria-label={t('Success')}
                  />
                ) : (
                  <XCircle
                    className='text-destructive size-4 shrink-0'
                    aria-label={t('Failed')}
                  />
                )}
                <span className='min-w-0 flex-1'>
                  {formatTimestampToDate(record.time)}
                </span>
                <span className='text-muted-foreground shrink-0'>
                  {formatNumber(record.duration_ms, locale)} ms
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Dialog>
  )
}
