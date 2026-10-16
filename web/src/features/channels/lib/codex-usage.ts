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
export type CodexRateLimitWindow = {
  used_percent?: number
  reset_at?: number
  reset_after_seconds?: number
  limit_window_seconds?: number
}

export type RateLimitSource = {
  plan_type?: string
  rate_limit?: {
    plan_type?: string
    primary_window?: CodexRateLimitWindow
    secondary_window?: CodexRateLimitWindow
  }
}

export function resolveRateLimitWindows(data: RateLimitSource | null): {
  fiveHourWindow: CodexRateLimitWindow | null
  weeklyWindow: CodexRateLimitWindow | null
} {
  const rateLimit = data?.rate_limit ?? {}
  const primary = rateLimit.primary_window ?? null
  const secondary = rateLimit.secondary_window ?? null
  const windows = [primary, secondary].filter(Boolean) as CodexRateLimitWindow[]
  const planType = String(data?.plan_type ?? rateLimit.plan_type ?? '')
    .trim()
    .toLowerCase()
  let fiveHourWindow: CodexRateLimitWindow | null = null
  let weeklyWindow: CodexRateLimitWindow | null = null
  for (const window of windows) {
    const seconds = Number(window.limit_window_seconds)
    if (!Number.isFinite(seconds) || seconds <= 0) continue
    if (seconds >= 86400) {
      weeklyWindow ??= window
    } else {
      fiveHourWindow ??= window
    }
  }
  if (planType === 'free') {
    return {
      fiveHourWindow: null,
      weeklyWindow: weeklyWindow ?? primary ?? secondary,
    }
  }
  if (!fiveHourWindow && !weeklyWindow) {
    return { fiveHourWindow: primary, weeklyWindow: secondary }
  }
  fiveHourWindow ??= windows.find((window) => window !== weeklyWindow) ?? null
  weeklyWindow ??= windows.find((window) => window !== fiveHourWindow) ?? null
  return { fiveHourWindow, weeklyWindow }
}

export function getWindowUsage(window: CodexRateLimitWindow): {
  used: number | null
  remaining: number | null
} {
  if (
    typeof window.used_percent !== 'number' ||
    !Number.isFinite(window.used_percent)
  ) {
    return { used: null, remaining: null }
  }
  const used = Math.min(100, Math.max(0, window.used_percent))
  return { used, remaining: 100 - used }
}

export function getWindowResetAt(
  window: CodexRateLimitWindow,
  fetchedAt: number
): number | null {
  if (
    typeof window.reset_at === 'number' &&
    Number.isFinite(window.reset_at) &&
    window.reset_at > 0
  ) {
    return window.reset_at
  }
  if (
    typeof window.reset_after_seconds === 'number' &&
    Number.isFinite(window.reset_after_seconds) &&
    window.reset_after_seconds >= 0
  ) {
    return Math.floor(fetchedAt / 1000) + window.reset_after_seconds
  }
  return null
}
