package controller

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/robfig/cron/v3"
)

const channelScheduledTestTaskType = "channel_scheduled_test"

func parseChannelTestSchedule(expression, timezone string, now time.Time) (int64, error) {
	if len(expression) > 128 || len(strings.Fields(expression)) != 5 {
		return 0, errors.New("Invalid cron expression")
	}
	location, err := time.LoadLocation(timezone)
	if err != nil || timezone == "" || timezone == "Local" {
		return 0, errors.New("Invalid timezone")
	}
	schedule, err := cron.ParseStandard(expression)
	if err != nil {
		return 0, errors.New("Invalid cron expression")
	}
	next := schedule.Next(now.In(location))
	if next.IsZero() {
		return 0, errors.New("Invalid cron expression")
	}
	return next.Unix(), nil
}

func GetChannelScheduledTest(c *gin.Context) {
	channelID, err := strconv.Atoi(c.Param("id"))
	if err != nil || channelID <= 0 {
		common.ApiErrorT(c, "Invalid channel ID")
		return
	}
	if _, err := model.GetChannelById(channelID, false); err != nil {
		common.ApiError(c, err)
		return
	}
	schedule, err := model.GetChannelTestSchedule(channelID)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	history := []model.ChannelScheduledTestRecord{}
	if schedule.History != "" {
		if err := common.UnmarshalJsonStr(schedule.History, &history); err != nil {
			common.ApiError(c, err)
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"schedule": schedule, "history": history}})
}

func SaveChannelScheduledTest(c *gin.Context) {
	channelID, err := strconv.Atoi(c.Param("id"))
	if err != nil || channelID <= 0 {
		common.ApiErrorT(c, "Invalid channel ID")
		return
	}
	channel, err := model.GetChannelById(channelID, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	var input struct {
		Enabled  bool   `json:"enabled"`
		Cron     string `json:"cron"`
		Timezone string `json:"timezone"`
		Model    string `json:"model"`
	}
	if err := common.DecodeJson(c.Request.Body, &input); err != nil {
		common.ApiErrorT(c, "Invalid request body")
		return
	}
	input.Cron = strings.TrimSpace(input.Cron)
	input.Model = strings.TrimSpace(input.Model)
	if len(input.Model) > 255 || len(input.Timezone) > 128 {
		common.ApiErrorT(c, "Invalid request body")
		return
	}
	nextRun, err := parseChannelTestSchedule(input.Cron, input.Timezone, time.Now())
	if err != nil {
		common.ApiError(c, common.NewMessage(err.Error()))
		return
	}
	if input.Model != "" && !slices.Contains(strings.Split(channel.Models, ","), input.Model) {
		common.ApiErrorT(c, "Model is not available in this channel")
		return
	}
	if !input.Enabled {
		nextRun = 0
	}
	schedule := &model.ChannelTestSchedule{
		ChannelID: channelID, Enabled: input.Enabled, Cron: input.Cron,
		Timezone: input.Timezone, Model: input.Model, NextRun: nextRun, History: "[]",
	}
	if err := model.SaveChannelTestSchedule(schedule); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccessT(c, "Saved successfully", nil)
}

// The existing system task lease serializes sweeps across master nodes. Each
// schedule is also claimed atomically, so a restart cannot replay a due slot.
type channelScheduledTestHandler struct{}

func (channelScheduledTestHandler) Type() string { return channelScheduledTestTaskType }
func (channelScheduledTestHandler) Enabled() bool {
	var count int64
	return model.DB.Model(&model.ChannelTestSchedule{}).
		Where("enabled = ? AND next_run <= ?", true, time.Now().Unix()).
		Where("channel_id IN (?)", model.DB.Model(&model.Channel{}).Select("id")).
		Count(&count).Error == nil && count > 0
}
func (channelScheduledTestHandler) Interval() time.Duration { return 15 * time.Second }
func (channelScheduledTestHandler) NewPayload() any         { return nil }

func (channelScheduledTestHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	var schedules []model.ChannelTestSchedule
	if err := model.DB.Where("enabled = ? AND next_run <= ?", true, time.Now().Unix()).
		Where("channel_id IN (?)", model.DB.Model(&model.Channel{}).Select("id")).
		Order("channel_id").Find(&schedules).Error; err != nil {
		finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, nil, err)
		return
	}
	testUserID, err := resolveChannelTestUserID(nil)
	if err != nil {
		finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, nil, err)
		return
	}
	summary := channelTestSummary{}
	for _, schedule := range schedules {
		if ctx.Err() != nil {
			finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, summary, ctx.Err())
			return
		}
		now := time.Now()
		nextRun, err := parseChannelTestSchedule(schedule.Cron, schedule.Timezone, now)
		if err != nil {
			finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, summary, err)
			return
		}
		claimed, err := model.ClaimChannelScheduledTest(&schedule, now.Unix(), nextRun)
		if err != nil {
			finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, summary, err)
			return
		}
		if !claimed {
			continue
		}
		channel, err := model.GetChannelById(schedule.ChannelID, true)
		if err != nil || channel.Status == common.ChannelStatusManuallyDisabled {
			continue
		}
		testCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		started := time.Now()
		result := testChannel(testCtx, channel, testUserID, schedule.Model, "", shouldUseStreamForAutomaticChannelTest(channel, schedule.Model))
		duration := time.Since(started).Milliseconds()
		cancel()
		if ctx.Err() != nil {
			finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, summary, ctx.Err())
			return
		}
		success := result.localErr == nil && result.newAPIError == nil
		record := model.ChannelScheduledTestRecord{Time: now.Unix(), Success: success, DurationMS: duration, Model: schedule.Model}
		if err := model.RecordChannelScheduledTest(schedule.ChannelID, record); err != nil {
			finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, summary, err)
			return
		}
		channel.UpdateResponseTime(duration)
		summary.Tested++
		if success {
			summary.Succeeded++
		} else {
			summary.Failed++
		}
	}
	finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusSucceeded, summary, nil)
}
