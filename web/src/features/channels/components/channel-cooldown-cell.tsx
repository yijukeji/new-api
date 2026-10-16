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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { Switch } from '@/components/ui/switch'
import {
  ADMIN_PERMISSION_ACTIONS,
  ADMIN_PERMISSION_RESOURCES,
  hasPermission,
} from '@/lib/admin-permissions'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { resetChannelCooldown } from '../api'
import { channelsQueryKeys, isTagAggregateRow } from '../lib'
import type { Channel, GetChannelsResponse } from '../types'

export function ChannelCooldownCell(props: { channel: Channel }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.auth.user)
  const canOperate = hasPermission(
    user,
    ADMIN_PERMISSION_RESOURCES.CHANNEL,
    ADMIN_PERMISSION_ACTIONS.OPERATE
  )
  const mutation = useMutation({
    mutationFn: async () =>
      requireServerSuccess(await resetChannelCooldown(props.channel.id)),
    onMutate: () =>
      queryClient.cancelQueries({ queryKey: channelsQueryKeys.lists() }),
    onSuccess: async () => {
      queryClient.setQueriesData<GetChannelsResponse>(
        { queryKey: channelsQueryKeys.lists() },
        (response) => {
          if (!response?.data) return response
          return {
            ...response,
            data: {
              ...response.data,
              items: response.data.items.map((channel) =>
                channel.id === props.channel.id
                  ? { ...channel, cooldown_active: false }
                  : channel
              ),
            },
          }
        }
      )
      await queryClient.invalidateQueries({
        queryKey: channelsQueryKeys.lists(),
      })
    },
    onError: (error) =>
      handleServerError(error, t('Failed to reset channel cooldown')),
  })

  if (isTagAggregateRow(props.channel)) {
    return <span className='text-muted-foreground text-xs'>-</span>
  }
  const active = props.channel.cooldown_active
  if (active == null) {
    return <span className='text-muted-foreground text-xs'>{t('Unknown')}</span>
  }
  return (
    <div
      className='flex items-center gap-2'
      onClick={(event) => event.stopPropagation()}
    >
      <Switch
        size='sm'
        aria-label={t('Circuit breaker')}
        aria-busy={mutation.isPending}
        checked={active}
        disabled={!active || !canOperate || mutation.isPending}
        onCheckedChange={(checked) => {
          if (!checked && active && canOperate && !mutation.isPending) {
            mutation.mutate()
          }
        }}
      />
      <span className='text-xs whitespace-nowrap'>
        {active ? t('Tripped') : t('Normal')}
      </span>
    </div>
  )
}
