package model

import (
	"errors"
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	tokenSpendFiveHourSeconds = int64(5 * 3600)
	tokenSpendWeekSeconds     = int64(7 * 86400)
	tokenSpendUpdateAttempts  = 8
)

// 日额度按东八区零点重置；中国无夏令时，固定时区避免依赖镜像内的 tzdata。
var tokenSpendDayZone = time.FixedZone("CST", 8*3600)

// TokenSpendUsage 记录开启消费限制的密钥在各窗口内的净扣费。
// 起点为 0 表示该窗口尚未开启，由下一次获准请求开启。
type TokenSpendUsage struct {
	TokenId       int   `json:"token_id" gorm:"primaryKey;autoIncrement:false"`
	FiveHourStart int64 `json:"five_hour_start" gorm:"bigint;default:0"`
	FiveHourUsed  int   `json:"five_hour_used" gorm:"default:0"`
	DayStart      int64 `json:"day_start" gorm:"bigint;default:0"`
	DayUsed       int   `json:"day_used" gorm:"default:0"`
	WeekStart     int64 `json:"week_start" gorm:"bigint;default:0"`
	WeekUsed      int   `json:"week_used" gorm:"default:0"`
}

// TokenSpendLimitError 表示请求被消费限制拒绝，RetryAfter 为最长等待秒数。
type TokenSpendLimitError struct {
	RetryAfter int64
}

func (e *TokenSpendLimitError) Error() string {
	return fmt.Sprintf("token spend limit reached, retry after %d seconds", e.RetryAfter)
}

func (token *Token) SpendLimitActive() bool {
	return token.SpendLimitEnabled && token.Id > 0
}

func tokenSpendDayStart(now int64) int64 {
	t := time.Unix(now, 0).In(tokenSpendDayZone)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, tokenSpendDayZone).Unix()
}

// rolled 返回 now 时刻的窗口状态：到期的 5 小时窗口关闭，日窗口按自然日切换，
// 7 天窗口按固定周期推进，空闲不会推迟重置时间。
func (u TokenSpendUsage) rolled(now int64) TokenSpendUsage {
	if u.FiveHourStart != 0 && now >= u.FiveHourStart+tokenSpendFiveHourSeconds {
		u.FiveHourStart, u.FiveHourUsed = 0, 0
	}
	if day := tokenSpendDayStart(now); u.DayStart != day {
		u.DayStart, u.DayUsed = day, 0
	}
	if u.WeekStart != 0 && now >= u.WeekStart+tokenSpendWeekSeconds {
		u.WeekStart += (now - u.WeekStart) / tokenSpendWeekSeconds * tokenSpendWeekSeconds
		u.WeekUsed = 0
	}
	return u
}

// NextResets 返回各窗口的下次重置时间，0 表示窗口尚未开启。
func (u TokenSpendUsage) NextResets() (fiveHour, day, week int64) {
	if u.FiveHourStart != 0 {
		fiveHour = u.FiveHourStart + tokenSpendFiveHourSeconds
	}
	day = time.Unix(u.DayStart, 0).In(tokenSpendDayZone).AddDate(0, 0, 1).Unix()
	if u.WeekStart != 0 {
		week = u.WeekStart + tokenSpendWeekSeconds
	}
	return fiveHour, day, week
}

// tokenSpendWindow 描述一个窗口的列与当前值，便于统一生成更新语句。
type tokenSpendWindow struct {
	startCol, usedCol string
	oldStart          int64
	start             int64
	used              int
	limit             int
}

func tokenSpendWindows(old, next TokenSpendUsage, token *Token) []tokenSpendWindow {
	return []tokenSpendWindow{
		{"five_hour_start", "five_hour_used", old.FiveHourStart, next.FiveHourStart, next.FiveHourUsed, token.SpendLimitFiveHour},
		{"day_start", "day_used", old.DayStart, next.DayStart, next.DayUsed, token.SpendLimitDaily},
		{"week_start", "week_used", old.WeekStart, next.WeekStart, next.WeekUsed, token.SpendLimitWeekly},
	}
}

func getTokenSpendUsage(tokenId int) (*TokenSpendUsage, error) {
	var usage TokenSpendUsage
	err := DB.Where("token_id = ?", tokenId).Take(&usage).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &usage, nil
}

// GetTokenSpendUsageView 返回当前时刻（已滚动、不落库）的用量视图。
func GetTokenSpendUsageView(tokenId int) (TokenSpendUsage, error) {
	usage, err := getTokenSpendUsage(tokenId)
	if err != nil {
		return TokenSpendUsage{}, err
	}
	if usage == nil {
		usage = &TokenSpendUsage{TokenId: tokenId}
	}
	return usage.rolled(common.GetTimestamp()), nil
}

func tokenSpendRetryAfter(next TokenSpendUsage, token *Token, quota int, now int64) int64 {
	fiveHourReset, dayReset, weekReset := next.NextResets()
	retryAfter := int64(1)
	for _, window := range []struct {
		used, limit int
		reset       int64
	}{
		{next.FiveHourUsed, token.SpendLimitFiveHour, fiveHourReset},
		{next.DayUsed, token.SpendLimitDaily, dayReset},
		{next.WeekUsed, token.SpendLimitWeekly, weekReset},
	} {
		if window.limit > 0 && window.used+max(quota, 1) > window.limit && window.reset > now {
			retryAfter = max(retryAfter, window.reset-now)
		}
	}
	return retryAfter
}

// reserveTokenSpend 在所有非零上限都满足 已用 + 本次 <= 上限 时累加用量，否则返回
// *TokenSpendLimitError。本次为 0 时，任一窗口已达上限也会拒绝。
func reserveTokenSpend(token *Token, quota int) error {
	for range tokenSpendUpdateAttempts {
		now := common.GetTimestamp()
		stored, err := getTokenSpendUsage(token.Id)
		if err != nil {
			return err
		}
		old := TokenSpendUsage{TokenId: token.Id}
		if stored != nil {
			old = *stored
		}
		next := old.rolled(now)
		if next.FiveHourStart == 0 {
			next.FiveHourStart = now
		}
		if next.WeekStart == 0 {
			next.WeekStart = now
		}
		windows := tokenSpendWindows(old, next, token)
		for _, window := range windows {
			if window.limit > 0 && window.used+max(quota, 1) > window.limit {
				return &TokenSpendLimitError{RetryAfter: tokenSpendRetryAfter(next, token, quota, now)}
			}
		}

		if stored == nil {
			next.FiveHourUsed += quota
			next.DayUsed += quota
			next.WeekUsed += quota
			result := DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&next)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 1 {
				return nil
			}
			continue
		}

		query := DB.Model(&TokenSpendUsage{}).Where("token_id = ?", token.Id)
		updates := map[string]any{}
		startChanged := false
		for _, window := range windows {
			query = query.Where(window.startCol+" = ?", window.oldStart)
			if window.start != window.oldStart {
				startChanged = true
				updates[window.startCol] = window.start
				updates[window.usedCol] = window.used + quota
				continue
			}
			updates[window.usedCol] = gorm.Expr(window.usedCol+" + ?", quota)
			if window.limit > 0 {
				// 并发请求可能在读取后累加，条件更新保证不会越过上限。
				query = query.Where(window.usedCol+" + ? <= ?", max(quota, 1), window.limit)
			}
		}
		if quota == 0 && !startChanged {
			// 仅检查不累加：上限已在读取值上校验，无需写库（MySQL 对未变化的行返回 0 影响行数）。
			return nil
		}
		result := query.Updates(updates)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 1 {
			return nil
		}
	}
	return errors.New("token spend usage update conflict")
}

// adjustTokenSpend 将结算差额（正数补扣、负数退还）计入仍在进行的窗口；
// 已在本次滚动的窗口丢弃差额，退还最低扣到 0。
// ponytail: 差额按到达时刻归属，跨窗口的长异步任务可能计入新窗口；需要精确归属时为差额携带预扣时间。
func adjustTokenSpend(token *Token, delta int) error {
	if delta == 0 {
		return nil
	}
	stored, err := getTokenSpendUsage(token.Id)
	if err != nil || stored == nil {
		return err
	}
	next := stored.rolled(common.GetTimestamp())
	// 以读取时的窗口起点作为条件：期间若有其他请求切换了窗口，差额属于旧窗口，直接丢弃。
	query := DB.Model(&TokenSpendUsage{}).Where("token_id = ?", token.Id)
	updates := map[string]any{}
	for _, window := range tokenSpendWindows(*stored, next, token) {
		query = query.Where(window.startCol+" = ?", window.oldStart)
		switch {
		case window.start != window.oldStart:
			updates[window.startCol] = window.start
			updates[window.usedCol] = window.used
		case window.start == 0:
		case delta > 0:
			updates[window.usedCol] = gorm.Expr(window.usedCol+" + ?", delta)
		default:
			updates[window.usedCol] = gorm.Expr("CASE WHEN "+window.usedCol+" > ? THEN "+window.usedCol+" - ? ELSE 0 END", -delta, -delta)
		}
	}
	if len(updates) == 0 {
		return nil
	}
	return query.Updates(updates).Error
}

// spendLimitToken 返回开启了消费限制的密钥配置，未开启时返回 nil。
func spendLimitToken(key string) (*Token, error) {
	if key == "" {
		return nil, nil
	}
	token, err := GetTokenByKey(key, false)
	if err != nil {
		return nil, err
	}
	if !token.SpendLimitActive() {
		return nil, nil
	}
	return token, nil
}

// ReserveTokenSpend 在预扣前检查并累加消费限制用量，供开启了限制的密钥调用；
// 未开启时直接放行。超限返回 *TokenSpendLimitError。
func ReserveTokenSpend(key string, quota int) error {
	if quota < 0 {
		return errors.New("quota cannot be negative")
	}
	token, err := spendLimitToken(key)
	if err != nil || token == nil {
		return err
	}
	return reserveTokenSpend(token, quota)
}

// ReleaseTokenSpend 撤销 ReserveTokenSpend 计入的用量（后续额度预扣失败时调用）。
func ReleaseTokenSpend(tokenId int, key string, quota int) {
	applyTokenSpendDelta(tokenId, key, -quota)
}

// applyTokenSpendDelta 将密钥额度的变动同步到消费限制用量，失败只记录日志，不影响扣费。
func applyTokenSpendDelta(tokenId int, key string, delta int) {
	// 绝大多数密钥从未开启限制、没有用量行；先按主键查行，避免每次结算都读取密钥配置。
	stored, err := getTokenSpendUsage(tokenId)
	if err == nil && stored != nil {
		var token *Token
		token, err = spendLimitToken(key)
		if err == nil && token != nil {
			err = adjustTokenSpend(token, delta)
		}
	}
	if err != nil {
		common.SysError(common.LogText("failed to adjust token spend usage: %s", err.Error()))
	}
}
