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
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import type { ScheduledTestData } from '../../api'
import type { Channel } from '../../types'
import { ScheduledTestDialog } from '../dialogs/scheduled-test-dialog'

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
let data: ScheduledTestData

function renderDialog(onClose = vi.fn()) {
  const channel = {
    id: 42,
    name: 'Test Codex',
    models: 'gpt-5-codex,gpt-5',
  } as Channel
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <ScheduledTestDialog channel={channel} onClose={onClose} />
      </I18nextProvider>
    </QueryClientProvider>
  )
  return onClose
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  data = {
    schedule: {
      channel_id: 42,
      enabled: false,
      cron: '0 */6 * * *',
      timezone: 'Asia/Shanghai',
      model: '',
      next_run: 0,
      last_run: 0,
    },
    history: [],
  }
  vi.spyOn(api, 'get').mockImplementation(async () => ({
    data: { success: true, data },
  }))
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

it('enables the schedule, applies a preset, and saves the selected model', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  const onClose = renderDialog()
  const enabled = await screen.findByRole('switch', {
    name: 'Enable scheduled test',
  })
  expect(screen.getByLabelText('Cron expression')).toBeDisabled()
  await userEvent.click(enabled)
  await userEvent.click(screen.getByRole('button', { name: 'Daily at 08:00' }))
  await userEvent.selectOptions(
    screen.getByLabelText('Test model'),
    'gpt-5-codex'
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Save configuration' })
  )
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  expect(put).toHaveBeenCalledWith(
    '/api/channel/42/scheduled-test',
    expect.objectContaining({
      enabled: true,
      cron: '0 8 * * *',
      timezone: 'Asia/Shanghai',
      model: 'gpt-5-codex',
    })
  )
})

it('rejects a cron expression with the wrong number of fields', async () => {
  const put = vi.spyOn(api, 'put')
  renderDialog()
  await userEvent.click(
    await screen.findByRole('switch', { name: 'Enable scheduled test' })
  )
  const cron = screen.getByLabelText('Cron expression')
  await userEvent.clear(cron)
  await userEvent.type(cron, '* *')
  await userEvent.click(
    screen.getByRole('button', { name: 'Save configuration' })
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Invalid cron expression'
  )
  expect(put).not.toHaveBeenCalled()
})

it('refreshes history without replacing unsaved cron edits', async () => {
  data.schedule.enabled = true
  renderDialog()
  const cron = await screen.findByLabelText('Cron expression')
  await userEvent.clear(cron)
  await userEvent.type(cron, '0 12 * * *')
  act(() =>
    client.setQueryData(['channels', 'scheduled-test', 42], {
      ...data,
      history: [{ time: 1000, success: true, duration_ms: 123, model: '' }],
    })
  )
  expect(await screen.findByLabelText('Success')).toBeInTheDocument()
  expect(cron).toHaveValue('0 12 * * *')
})

it('keeps the dialog open when saving fails', async () => {
  vi.spyOn(api, 'put').mockResolvedValue({
    data: { success: false, message: 'Invalid cron expression' },
  })
  const onClose = renderDialog()
  await screen.findByRole('switch', { name: 'Enable scheduled test' })
  await userEvent.click(
    screen.getByRole('button', { name: 'Save configuration' })
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save configuration' })
    ).not.toBeDisabled()
  )
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

it('shows a retry action when loading the schedule fails', async () => {
  vi.mocked(api.get).mockResolvedValueOnce({
    data: { success: false, message: 'Unavailable' },
  })
  renderDialog()
  await userEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  expect(
    await screen.findByRole('switch', { name: 'Enable scheduled test' })
  ).toBeInTheDocument()
})
