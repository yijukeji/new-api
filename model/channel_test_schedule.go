package model

import (
	"errors"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ChannelTestSchedule is independent of channel credentials and relay settings.
type ChannelTestSchedule struct {
	ChannelID int    `json:"channel_id" gorm:"primaryKey;autoIncrement:false"`
	Enabled   bool   `json:"enabled"`
	Cron      string `json:"cron" gorm:"type:varchar(128)"`
	Timezone  string `json:"timezone" gorm:"type:varchar(128)"`
	Model     string `json:"model" gorm:"type:varchar(255)"`
	NextRun   int64  `json:"next_run" gorm:"bigint;index"`
	LastRun   int64  `json:"last_run" gorm:"bigint"`
	History   string `json:"-" gorm:"type:text"`
}

type ChannelScheduledTestRecord struct {
	Time       int64  `json:"time"`
	Success    bool   `json:"success"`
	DurationMS int64  `json:"duration_ms"`
	Model      string `json:"model"`
}

func GetChannelTestSchedule(channelID int) (*ChannelTestSchedule, error) {
	var schedule ChannelTestSchedule
	err := DB.First(&schedule, "channel_id = ?", channelID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return &ChannelTestSchedule{ChannelID: channelID, Cron: "0 */6 * * *", Timezone: "Asia/Shanghai", History: "[]"}, nil
	}
	return &schedule, err
}

func SaveChannelTestSchedule(schedule *ChannelTestSchedule) error {
	return DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "channel_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"enabled", "cron", "timezone", "model", "next_run"}),
	}).Create(schedule).Error
}

func ClaimChannelScheduledTest(schedule *ChannelTestSchedule, now, nextRun int64) (bool, error) {
	result := DB.Model(&ChannelTestSchedule{}).
		Where("channel_id = ? AND enabled = ? AND next_run = ? AND next_run <= ? AND cron = ? AND timezone = ? AND model = ?",
			schedule.ChannelID, true, schedule.NextRun, now, schedule.Cron, schedule.Timezone, schedule.Model).
		Updates(map[string]any{"next_run": nextRun, "last_run": now})
	return result.RowsAffected == 1, result.Error
}

func RecordChannelScheduledTest(channelID int, record ChannelScheduledTestRecord) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var schedule ChannelTestSchedule
		if err := lockForUpdate(tx).First(&schedule, "channel_id = ?", channelID).Error; err != nil {
			return err
		}
		history := make([]ChannelScheduledTestRecord, 0, 5)
		if schedule.History != "" {
			if err := common.UnmarshalJsonStr(schedule.History, &history); err != nil {
				return err
			}
		}
		history = append([]ChannelScheduledTestRecord{record}, history...)
		history = history[:min(len(history), 5)]
		encoded, err := common.Marshal(history)
		if err != nil {
			return err
		}
		return tx.Model(&schedule).Update("history", string(encoded)).Error
	})
}
