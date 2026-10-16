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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import type { Channel } from '../../types'
import { ChannelCard } from '../channel-card'
import { SessionUsageCell } from '../session-usage-cell'

const state = vi.hoisted(() => ({ sensitiveVisible: true }))
vi.mock('../channels-provider', () => ({ useChannels: () => state }))
const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
})
let client: QueryClient

function renderCell(overrides: Partial<Channel> = {}) {
  const channel = {
    id: 42,
    type: 57,
    channel_info: { is_multi_key: false },
    ...overrides,
  } as Channel
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <SessionUsageCell channel={channel} />
      </I18nextProvider>
    </QueryClientProvider>
  )
}
beforeEach(() => {
  state.sensitiveVisible = true
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})

it('shows both used and remaining percentages from the upstream', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 18000,
            reset_at: Date.now() / 1000 + 7200,
          },
          secondary_window: { used_percent: 0, limit_window_seconds: 604800 },
        },
      },
    },
  })
  renderCell()
  expect(await screen.findByText('25%')).toBeInTheDocument()
  expect(screen.getByText('Remaining: 75%')).toBeInTheDocument()
  expect(screen.getByText('Remaining: 100%')).toBeInTheDocument()
  expect(
    screen.getByRole('progressbar', { name: '5h Used: 25%' })
  ).toHaveAttribute('aria-valuenow', '25')
})

it('shows a failed fetch as unavailable and lets the user retry', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValueOnce({
      data: { success: false, message: 'upstream unavailable' },
    })
    .mockResolvedValue({
      data: {
        success: true,
        data: { rate_limit: { primary_window: { used_percent: 40 } } },
      },
    })
  renderCell()
  expect(await screen.findByText('Usage unavailable')).toBeInTheDocument()
  expect(screen.queryByText('0%')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
  expect(await screen.findByText('40%')).toBeInTheDocument()
  expect(get).toHaveBeenCalledTimes(2)
})

it.each([{ type: 1 }, { channel_info: { is_multi_key: true } }])(
  'does not query unsupported channels %o',
  (overrides) => {
    const get = vi.spyOn(api, 'get')
    renderCell(overrides as Partial<Channel>)
    expect(get).not.toHaveBeenCalled()
  }
)

it('hides usage and makes no upstream request while sensitive data is hidden', () => {
  state.sensitiveVisible = false
  const get = vi.spyOn(api, 'get')
  renderCell()
  expect(screen.getByText('••••')).toBeInTheDocument()
  expect(get).not.toHaveBeenCalled()
})

function ChannelCardFixture() {
  const channel = {
    id: 42,
    type: 57,
    status: 1,
    group: '',
    channel_info: { is_multi_key: false },
  } as Channel
  const helper = createColumnHelper<Channel>()
  const table = useReactTable({
    data: [channel],
    columns: [
      helper.display({
        id: 'session_usage',
        cell: (context) => <SessionUsageCell channel={context.row.original} />,
      }),
    ],
    getCoreRowModel: getCoreRowModel(),
  })
  return <ChannelCard row={table.getRowModel().rows[0]} isSelected={false} />
}

it('shows the same session window usage in the mobile channel card', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { rate_limit: { primary_window: { used_percent: 25 } } },
    },
  })
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <ChannelCardFixture />
      </I18nextProvider>
    </QueryClientProvider>
  )
  expect(
    await screen.findByRole('region', { name: 'Session windows' })
  ).toBeInTheDocument()
  expect(await screen.findByText('Remaining: 75%')).toBeInTheDocument()
})
