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
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { channelsQueryKeys } from '../../lib'
import type { Channel, GetChannelsResponse } from '../../types'
import { ChannelCard } from '../channel-card'
import { useChannelsColumns } from '../channels-columns'
import { ChannelsProvider } from '../channels-provider'

const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
})
const originalAuth = useAuthStore.getState().auth
let client: QueryClient

function Fixture(props: { card?: boolean }) {
  const { data } = useQuery<GetChannelsResponse>({
    queryKey: channelsQueryKeys.list({}),
    queryFn: async () =>
      client.getQueryData<GetChannelsResponse>(channelsQueryKeys.list({})) ?? {
        success: true,
      },
    staleTime: Infinity,
  })
  const columns = useChannelsColumns({ enableSelection: false })
  const table = useReactTable({
    data: data?.data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  })
  const row = table.getRowModel().rows[0]
  if (props.card) return <ChannelCard row={row} isSelected={false} />
  return (
    <table>
      <thead>
        <tr>
          {table.getHeaderGroups()[0].headers.map((header) => (
            <th key={header.id}>
              {flexRender(header.column.columnDef.header, header.getContext())}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          {row.getAllCells().map((cell) => (
            <td key={cell.id}>
              {cell.column.id === 'cooldown_active' &&
                flexRender(cell.column.columnDef.cell, cell.getContext())}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  )
}
function renderSwitch(active: boolean | null = true, card = false) {
  client.setQueryData(channelsQueryKeys.list({}), {
    success: true,
    data: {
      items: [
        {
          id: 42,
          name: 'Test channel',
          type: 1,
          status: 1,
          group: '',
          models: '',
          channel_info: { is_multi_key: false },
          cooldown_active: active,
        } as Channel,
      ],
    },
  })
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <ChannelsProvider>
          <Fixture card={card} />
        </ChannelsProvider>
      </I18nextProvider>
    </QueryClientProvider>
  )
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore.setState({
    auth: {
      ...originalAuth,
      user: { id: 1, username: 'root', role: ROLE.SUPER_ADMIN },
    },
  })
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
  useAuthStore.setState({ auth: originalAuth })
})

it('shows circuit state in a column immediately after Weight', () => {
  renderSwitch()
  const headers = screen
    .getAllByRole('columnheader')
    .map((header) => header.textContent)
  expect(headers[headers.indexOf('Weight') + 1]).toBe('Circuit breaker')
  expect(screen.getByRole('switch', { name: 'Circuit breaker' })).toBeChecked()
  expect(screen.getByText('Tripped')).toBeInTheDocument()
})
it('clears a tripped circuit and refreshes the displayed state', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: true } })
  renderSwitch(true)
  await userEvent.click(screen.getByRole('switch', { name: 'Circuit breaker' }))
  expect(post).toHaveBeenCalledWith(
    '/api/channel/42/cooldown/reset',
    undefined,
    { skipBusinessError: true, skipErrorHandler: true }
  )
  await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked())
  expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByText('Normal')).toBeInTheDocument()
})
it('disables a healthy circuit switch and cannot manually trip the channel', async () => {
  const post = vi.spyOn(api, 'post')
  renderSwitch(false)
  const control = screen.getByRole('switch')
  expect(control).not.toBeChecked()
  expect(control).toHaveAttribute('aria-disabled', 'true')
  await userEvent.click(control)
  control.focus()
  await userEvent.keyboard(' ')
  expect(post).not.toHaveBeenCalled()
})
it('blocks duplicate toggles while the update is pending', async () => {
  let complete!: (value: { data: { success: boolean; data: boolean } }) => void
  const post = vi.spyOn(api, 'post').mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  renderSwitch()
  const control = screen.getByRole('switch')
  await userEvent.click(control)
  expect(control).toHaveAttribute('aria-disabled', 'true')
  await userEvent.click(control)
  expect(post).toHaveBeenCalledOnce()
  await act(async () => complete({ data: { success: true, data: false } }))
  await waitFor(() => expect(control).not.toBeChecked())
})
it.each(['business', 'network'])(
  'preserves circuit state and allows retry after a %s failure',
  async (failure) => {
    const post = vi.spyOn(api, 'post')
    if (failure === 'business') {
      post.mockResolvedValue({
        data: { success: false, message: 'Failed to reset channel cooldown' },
      })
    } else {
      post.mockRejectedValue(new Error('Network Error'))
    }
    const error = vi.spyOn(toast, 'error')
    renderSwitch()
    await userEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(error).toHaveBeenCalled())
    expect(screen.getByRole('switch')).toBeChecked()
    expect(screen.getByRole('switch')).not.toHaveAttribute(
      'aria-disabled',
      'true'
    )
    post.mockResolvedValue({ data: { success: true, data: false } })
    await userEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked())
  }
)
it('disables the switch without channel operate permission', async () => {
  useAuthStore.setState({
    auth: {
      ...originalAuth,
      user: { id: 2, username: 'reader', role: ROLE.ADMIN },
    },
  })
  const post = vi.spyOn(api, 'post')
  renderSwitch()
  expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true')
  await userEvent.click(screen.getByRole('switch'))
  expect(post).not.toHaveBeenCalled()
})
it('shows unavailable state without an actionable switch when circuit state cannot be read', () => {
  renderSwitch(null)
  expect(screen.getByText('Unknown')).toBeInTheDocument()
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
})
it('shows the same circuit switch in the channel card', () => {
  renderSwitch(true, true)
  expect(screen.getByRole('switch', { name: 'Circuit breaker' })).toBeChecked()
})
it('supports toggling with the keyboard', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: false },
  })
  renderSwitch()
  screen.getByRole('switch').focus()
  await userEvent.keyboard(' ')
  await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked())
})
