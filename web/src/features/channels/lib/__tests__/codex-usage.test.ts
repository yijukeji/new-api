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
import { describe, expect, it } from 'vitest'

import {
  getWindowResetAt,
  getWindowUsage,
  resolveRateLimitWindows,
} from '../codex-usage'

describe('Codex session windows', () => {
  it('classifies reversed windows by their upstream duration', () => {
    const weekly = { used_percent: 20, limit_window_seconds: 604800 }
    const hourly = { used_percent: 40, limit_window_seconds: 18000 }
    expect(
      resolveRateLimitWindows({
        rate_limit: { primary_window: weekly, secondary_window: hourly },
      })
    ).toEqual({ fiveHourWindow: hourly, weeklyWindow: weekly })
  })
  it('keeps the free plan primary window as a weekly window when duration is absent', () => {
    const primary = { used_percent: 25 }
    expect(
      resolveRateLimitWindows({
        plan_type: 'free',
        rate_limit: { primary_window: primary },
      })
    ).toEqual({ fiveHourWindow: null, weeklyWindow: primary })
  })
  it('does not manufacture windows when the upstream has none', () => {
    expect(resolveRateLimitWindows(null)).toEqual({
      fiveHourWindow: null,
      weeklyWindow: null,
    })
  })
  it.each([
    [{ used_percent: 0 }, { used: 0, remaining: 100 }],
    [{ used_percent: 32.5 }, { used: 32.5, remaining: 67.5 }],
    [{ used_percent: 125 }, { used: 100, remaining: 0 }],
    [{}, { used: null, remaining: null }],
    [{ used_percent: Number.NaN }, { used: null, remaining: null }],
  ])(
    'preserves explicit zero and distinguishes missing usage for %o',
    (window, expected) => {
      expect(getWindowUsage(window)).toEqual(expected)
    }
  )
  it('anchors a relative reset to the fetch time instead of each render', () => {
    expect(getWindowResetAt({ reset_after_seconds: 60 }, 1_000_000)).toBe(1060)
    expect(
      getWindowResetAt({ reset_at: 1200, reset_after_seconds: 60 }, 1_000_000)
    ).toBe(1200)
    expect(getWindowResetAt({}, 1_000_000)).toBeNull()
  })
})
