package service

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupChannelCooldownTest(t *testing.T) *channelCircuitStore {
	t.Helper()
	oldStore, oldRedis, oldCooldown := channelCircuits, common.RedisEnabled, common.ChannelFailureCooldownSeconds
	channelCircuits = &channelCircuitStore{states: make(map[int]channelCircuitState), now: time.Now}
	common.RedisEnabled, common.ChannelFailureCooldownSeconds = false, 300
	t.Cleanup(func() {
		channelCircuits, common.RedisEnabled, common.ChannelFailureCooldownSeconds = oldStore, oldRedis, oldCooldown
	})
	return channelCircuits
}

func newChannelCooldownContext(t *testing.T) *gin.Context {
	t.Helper()
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	t.Cleanup(func() { ReleaseChannelProbes(c) })
	return c
}

func TestChannelCooldownRecoveryOwnership(t *testing.T) {
	for _, backend := range []string{"memory", "redis"} {
		t.Run(backend, func(t *testing.T) {
			store := &channelCircuitStore{states: make(map[int]channelCircuitState), now: time.Now}
			var client *redis.Client
			if backend == "redis" {
				addr := os.Getenv("TEST_COOLDOWN_REDIS_ADDR")
				if addr == "" {
					addr = miniredis.RunT(t).Addr()
				}
				client = redis.NewClient(&redis.Options{Addr: addr})
				t.Cleanup(func() { require.NoError(t, client.Close()) })
				require.NoError(t, client.Del(context.Background(), "channel_circuit:v1:31000").Err())
			}
			transition := func(op, owner string, want int) {
				t.Helper()
				result, err := store.transition(client, 31000, op, owner, 5*time.Minute)
				require.NoError(t, err)
				assert.Equal(t, want, result, "%s %s", op, owner)
			}
			expire := func() {
				t.Helper()
				if client != nil {
					require.NoError(t, client.HSet(context.Background(), "channel_circuit:v1:31000", "until", 0).Err())
					return
				}
				store.mu.Lock()
				state := store.states[31000]
				state.until = time.Time{}
				store.states[31000] = state
				store.mu.Unlock()
			}
			transition("acquire", "healthy", 1)
			transition("fail", "", 1)
			transition("acquire", "too-early", 0)
			expire()
			transition("acquire", "first-probe", 2)
			transition("acquire", "second-probe", 0)
			expire()
			transition("renew", "first-probe", 1)
			transition("acquire", "while-streaming", 0)
			transition("fail", "", 1)
			transition("success", "first-probe", 0)
			transition("release", "first-probe", 0)
			transition("acquire", "after-new-failure", 0)
			expire()
			transition("acquire", "recovery", 2)
			transition("release", "first-probe", 0)
			transition("success", "recovery", 1)
			transition("acquire", "restored", 1)
			transition("fail", "", 1)
			expire()
			transition("acquire", "cancelled-probe", 2)
			transition("release", "cancelled-probe", 1)
			transition("acquire", "replacement", 2)
			transition("success", "replacement", 1)
			transition("fail", "", 1)
			transition("reset", "", 1)
			transition("reset", "", 0)
			transition("acquire", "manually-restored", 1)
			transition("fail", "", 1)
			expire()
			transition("acquire", "reset-probe", 2)
			transition("reset", "", 1)
			transition("renew", "reset-probe", 0)
			transition("release", "reset-probe", 0)
			transition("success", "reset-probe", 0)
			transition("acquire", "after-reset-probe", 1)
			transition("fail", "", 1)
			transition("success", "reset-probe", 0)
			transition("release", "reset-probe", 0)
			transition("renew", "reset-probe", 0)
			transition("acquire", "new-failure-after-reset", 0)
			transition("reset", "", 1)
		})
	}
}

func TestResetChannelCooldown(t *testing.T) {
	store := setupChannelCooldownTest(t)
	_, err := store.transition(nil, 31003, "fail", "", 5*time.Minute)
	require.NoError(t, err)
	changed, err := ResetChannelCooldown(31003)
	require.NoError(t, err)
	assert.True(t, changed)
	allowed, err := acquireChannelProbe(newChannelCooldownContext(t), 31003)
	require.NoError(t, err)
	assert.True(t, allowed)
	changed, err = ResetChannelCooldown(31003)
	require.NoError(t, err)
	assert.False(t, changed)
	_, err = ResetChannelCooldown(0)
	require.Error(t, err)

	previousClient := common.RDB
	t.Cleanup(func() { common.RDB = previousClient })
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	common.RedisEnabled, common.RDB = true, client
	_, err = store.transition(client, 31003, "fail", "", 5*time.Minute)
	require.NoError(t, err)
	changed, err = ResetChannelCooldown(31003)
	require.NoError(t, err)
	assert.True(t, changed)
	assert.False(t, server.Exists("channel_circuit:v1:31003"))
	require.NoError(t, client.Close())
	_, err = ResetChannelCooldown(31003)
	require.Error(t, err)
	common.RDB = nil
	_, err = ResetChannelCooldown(31003)
	require.Error(t, err)
}

func TestGetChannelCooldowns(t *testing.T) {
	for _, backend := range []string{"memory", "redis"} {
		t.Run(backend, func(t *testing.T) {
			store := setupChannelCooldownTest(t)
			previousClient := common.RDB
			t.Cleanup(func() { common.RDB = previousClient })
			var client *redis.Client
			var server *miniredis.Miniredis
			if backend == "redis" {
				server = miniredis.RunT(t)
				client = redis.NewClient(&redis.Options{Addr: server.Addr()})
				t.Cleanup(func() { _ = client.Close() })
				common.RedisEnabled, common.RDB = true, client
			}
			_, err := store.transition(client, 31004, "fail", "", 0)
			require.NoError(t, err)
			states, err := GetChannelCooldowns([]int{31004, 31005})
			require.NoError(t, err)
			assert.Equal(t, map[int]bool{31004: true, 31005: false}, states)
			// Reading a circuit awaiting recovery must not consume the probe lease.
			result, err := store.transition(client, 31004, "acquire", "probe", channelProbeLease)
			require.NoError(t, err)
			assert.Equal(t, 2, result)
			states, err = GetChannelCooldowns([]int{31004})
			require.NoError(t, err)
			assert.True(t, states[31004])
			_, err = ResetChannelCooldown(31004)
			require.NoError(t, err)
			states, err = GetChannelCooldowns([]int{31004})
			require.NoError(t, err)
			assert.False(t, states[31004])

			_, err = store.transition(client, 31004, "fail", "", 0)
			require.NoError(t, err)
			if server != nil {
				server.FastForward(channelCircuitRetention)
			} else {
				now := store.now()
				store.now = func() time.Time { return now.Add(channelCircuitRetention) }
			}
			states, err = GetChannelCooldowns([]int{31004})
			require.NoError(t, err)
			assert.False(t, states[31004], "expired retention must not show an active circuit")
			if client != nil {
				require.NoError(t, client.Close())
				states, err = GetChannelCooldowns([]int{31004})
				require.Error(t, err)
				assert.Nil(t, states, "unavailable state must not be reported as healthy")
				common.RDB = nil
				_, err = GetChannelCooldowns([]int{31004})
				require.Error(t, err)
			}
			states, err = GetChannelCooldowns(nil)
			require.NoError(t, err)
			assert.Empty(t, states)
		})
	}
}

func TestChannelCooldownConcurrentProbeAdmission(t *testing.T) {
	for _, backend := range []string{"memory", "redis"} {
		t.Run(backend, func(t *testing.T) {
			store := setupChannelCooldownTest(t)
			var clients [2]*redis.Client
			if backend == "redis" {
				addr := os.Getenv("TEST_COOLDOWN_REDIS_ADDR")
				if addr == "" {
					addr = miniredis.RunT(t).Addr()
				}
				for index := range clients {
					clients[index] = redis.NewClient(&redis.Options{Addr: addr})
					t.Cleanup(func() { require.NoError(t, clients[index].Close()) })
				}
			}
			_, err := store.transition(clients[0], 31001, "fail", "", 0)
			require.NoError(t, err)
			results := make(chan int, 2)
			var wg sync.WaitGroup
			for index, owner := range []string{"request-a", "request-b"} {
				wg.Go(func() {
					result, err := store.transition(clients[index], 31001, "acquire", owner, channelProbeLease)
					assert.NoError(t, err)
					results <- result
				})
			}
			wg.Wait()
			close(results)
			var admitted int
			for result := range results {
				if result == 2 {
					admitted++
				}
			}
			assert.Equal(t, 1, admitted)
		})
	}
}

func TestChannelCooldownFailureClassification(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  *types.NewAPIError
		want bool
	}{
		{"bad gateway", types.NewOpenAIError(errors.New("gateway"), types.ErrorCodeBadResponseStatusCode, 502), true},
		{"unavailable", types.WithOpenAIError(types.OpenAIError{Message: "unavailable"}, 503), true},
		{"gateway timeout", types.WithOpenAIError(types.OpenAIError{Message: "timeout"}, 504), true},
		{"claude overload", types.WithClaudeError(types.ClaudeError{Type: "overloaded_error"}, 500), true},
		{"connection refused", types.NewError(&net.OpError{Op: "dial", Net: "tcp", Err: errors.New("refused")}, types.ErrorCodeDoRequestFailed), true},
		{"bad parameter", types.WithOpenAIError(types.OpenAIError{Message: "bad request"}, 400), false},
		{"rate limit", types.WithOpenAIError(types.OpenAIError{Message: "rate limit"}, 429), false},
		{"local quota", types.NewErrorWithStatusCode(errors.New("quota"), types.ErrorCodeInsufficientUserQuota, 503), false},
		{"client cancellation", types.NewError(context.Canceled, types.ErrorCodeDoRequestFailed), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, channelFailureNeedsCooldown(newChannelCooldownContext(t), tc.err))
		})
	}
	c := newChannelCooldownContext(t)
	ctx, cancel := context.WithCancel(c.Request.Context())
	c.Request = c.Request.WithContext(ctx)
	cancel()
	assert.False(t, channelFailureNeedsCooldown(c, types.WithOpenAIError(types.OpenAIError{}, 503)))
}

func TestChannelCooldownProbeLifecycleAndStreamFailure(t *testing.T) {
	store := setupChannelCooldownTest(t)
	c := newChannelCooldownContext(t)
	c.Set("channel_id", 31002)
	failure := types.WithOpenAIError(types.OpenAIError{Message: "unavailable"}, 503)
	RecordPolicyFailure(c, 31002, failure, PolicyDecision{Action: "stop"})
	store.mu.Lock()
	state := store.states[31002]
	store.mu.Unlock()
	assert.WithinDuration(t, time.Now().Add(5*time.Minute), state.until, time.Second)
	allowed, err := acquireChannelProbe(newChannelCooldownContext(t), 31002)
	require.NoError(t, err)
	assert.False(t, allowed)
	store.mu.Lock()
	state.until = time.Time{}
	store.states[31002] = state
	store.mu.Unlock()
	probe := newChannelCooldownContext(t)
	probe.Set("channel_id", 31002)
	allowed, err = acquireChannelProbe(probe, 31002)
	require.NoError(t, err)
	require.True(t, allowed)
	ReleaseChannelProbes(probe)
	allowed, err = acquireChannelProbe(probe, 31002)
	require.NoError(t, err)
	require.True(t, allowed)
	stream := relaycommon.NewStreamStatus()
	stream.MarkFailed("overloaded_error", "overloaded_error", 503)
	stream.SetEndReason(relaycommon.StreamEndReasonDone, nil)
	MarkRequestPolicySuccess(probe, stream)
	assert.False(t, RequestPolicy(probe).Successful)
	allowed, err = acquireChannelProbe(newChannelCooldownContext(t), 31002)
	require.NoError(t, err)
	assert.False(t, allowed, "HTTP 200 with a failed SSE result must restart cooldown")
	store.mu.Lock()
	state = store.states[31002]
	state.until = time.Time{}
	store.states[31002] = state
	store.mu.Unlock()
	recovered := newChannelCooldownContext(t)
	recovered.Set("channel_id", 31002)
	allowed, err = acquireChannelProbe(recovered, 31002)
	require.NoError(t, err)
	require.True(t, allowed)
	MarkRequestPolicySuccess(recovered, nil)
	allowed, err = acquireChannelProbe(newChannelCooldownContext(t), 31002)
	require.NoError(t, err)
	assert.True(t, allowed)
}

// Run the same routing contract on a real database by setting
// TEST_COOLDOWN_SQL_DSN; the test runner must supply a disposable database.
func TestChannelCooldownRouting(t *testing.T) {
	db := setupChannelSelectAutoGroupsTest(t)
	store := setupChannelCooldownTest(t)
	{
		oldDB, oldMaster := model.DB, common.IsMasterNode
		oldSQLitePath := common.SQLitePath
		oldMain, oldLog := common.MainDatabaseType(), common.LogDatabaseType()
		t.Setenv("SQL_DSN", os.Getenv("TEST_COOLDOWN_SQL_DSN"))
		common.SQLitePath = filepath.Join(t.TempDir(), "cooldown.db")
		common.IsMasterNode = false
		require.NoError(t, model.InitDB())
		db = model.DB
		require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.Ability{}))
		sqlDB, err := db.DB()
		require.NoError(t, err)
		t.Cleanup(func() {
			require.NoError(t, sqlDB.Close())
			model.DB, common.IsMasterNode = oldDB, oldMaster
			common.SQLitePath = oldSQLitePath
			common.SetDatabaseTypes(oldMain, oldLog)
		})
	}
	var version string
	if db.Dialector.Name() == "sqlite" {
		require.NoError(t, db.Raw("select sqlite_version()").Scan(&version).Error)
	} else {
		require.NoError(t, db.Raw("select version()").Scan(&version).Error)
	}
	t.Logf("routing database: %s %s", db.Dialector.Name(), version)
	const modelName = "cooldown-routing"
	require.NoError(t, db.Where("model = ?", modelName).Delete(&model.Ability{}).Error)
	require.NoError(t, db.Where("models = ?", modelName).Delete(&model.Channel{}).Error)
	t.Cleanup(func() {
		require.NoError(t, db.Where("model = ?", modelName).Delete(&model.Ability{}).Error)
		require.NoError(t, db.Where("models = ?", modelName).Delete(&model.Channel{}).Error)
	})
	for index, priority := range []int64{10, 0, -10} {
		id := 31100 + index
		createChannelSelectAutoGroupsChannel(t, db, id, "default", modelName)
		require.NoError(t, db.Model(&model.Channel{}).Where("id = ?", id).Update("priority", priority).Error)
		require.NoError(t, db.Model(&model.Ability{}).Where("channel_id = ?", id).Update("priority", priority).Error)
	}
	createChannelSelectAutoGroupsChannel(t, db, 31103, "vip", modelName)
	model.InitChannelCache()
	for _, cached := range []bool{true, false} {
		t.Run(fmt.Sprintf("cached_%t", cached), func(t *testing.T) {
			common.MemoryCacheEnabled = cached
			store.mu.Lock()
			clear(store.states)
			store.mu.Unlock()
			c := newChannelCooldownContext(t)
			param := &RetryParam{Ctx: c, TokenGroup: "default", ModelName: modelName, Retry: common.GetPointer(1)}
			RecordPolicyFailure(c, 31101, types.WithOpenAIError(types.OpenAIError{}, 503), PolicyDecision{Action: "retry"})
			channel, _, err := CacheGetRandomSatisfiedChannel(param)
			require.NoError(t, err)
			require.NotNil(t, channel)
			assert.Equal(t, 31100, channel.Id, "a failed affinity channel must not skip a healthy higher-priority channel")
			RecordPolicyFailure(c, 31100, types.WithOpenAIError(types.OpenAIError{}, 400), PolicyDecision{Action: "retry"})
			channel, _, err = CacheGetRandomSatisfiedChannel(param)
			require.NoError(t, err)
			require.NotNil(t, channel)
			assert.Equal(t, 31102, channel.Id, "failed attempts are excluded even without global cooldown")
			fresh := newChannelCooldownContext(t)
			GetChannelConstraints(fresh).AddPin(dto.ChannelPin{ChannelId: 31101, Source: dto.PinSourceToken})
			_, _, selectErr := SelectChannelForRequest(fresh, modelName, &RetryParam{Ctx: fresh})
			require.NotNil(t, selectErr)
			assert.Equal(t, 503, selectErr.StatusCode)
			for _, id := range []int{31100, 31102} {
				require.True(t, recordChannelCooldown(fresh, id, types.WithOpenAIError(types.OpenAIError{}, 503)))
			}
			channel, _, err = CacheGetRandomSatisfiedChannel(&RetryParam{Ctx: newChannelCooldownContext(t), TokenGroup: "default", ModelName: modelName})
			require.NoError(t, err)
			assert.Nil(t, channel, "all cooling channels must return no candidate")
		})
	}
	store.mu.Lock()
	clear(store.states)
	store.mu.Unlock()
	affinity := operation_setting.GetChannelAffinitySetting()
	oldAffinity := *affinity
	t.Cleanup(func() { *affinity = oldAffinity })
	for _, mode := range []string{"prefer", "strict"} {
		rule := operation_setting.ChannelAffinityRule{
			Name: "cooldown-" + mode, ModelRegex: []string{"^" + modelName + "$"}, SessionMode: mode,
			KeySources: []operation_setting.ChannelAffinityKeySource{{Type: "request_header", Key: "X-Session"}},
		}
		affinity.Enabled, affinity.KeepOnChannelDisabled = true, false
		affinity.Rules = []operation_setting.ChannelAffinityRule{rule}
		key := t.Name() + mode
		cacheKey := buildChannelAffinityCacheKeySuffix(rule, modelName, "default", key)
		cache := getChannelAffinityCache()
		require.NoError(t, cache.SetWithTTL(cacheKey, 31101, time.Minute))
		t.Cleanup(func() { _, err := cache.DeleteMany([]string{cacheKey}); assert.NoError(t, err) })
		require.True(t, recordChannelCooldown(newChannelCooldownContext(t), 31101, types.WithOpenAIError(types.OpenAIError{}, 503)))
		for range 2 {
			c := newChannelCooldownContext(t)
			c.Request.Header.Set("X-Session", key)
			channel, _, selectErr := SelectChannelForRequest(c, modelName, &RetryParam{Ctx: c, TokenGroup: "default", ModelName: modelName})
			if mode == "strict" {
				require.NotNil(t, selectErr)
				assert.Equal(t, 503, selectErr.StatusCode)
				assert.Nil(t, channel)
			} else {
				require.Nil(t, selectErr)
				require.NotNil(t, channel)
				assert.Equal(t, 31100, channel.Id)
			}
		}
	}
	store.mu.Lock()
	clear(store.states)
	store.mu.Unlock()
	common.RetryTimes = 3
	for _, crossGroup := range []bool{false, true} {
		c := newChannelCooldownContext(t)
		common.SetContextKey(c, constant.ContextKeyUserGroup, "default")
		common.SetContextKey(c, constant.ContextKeyTokenAutoGroups, []string{"default", "vip"})
		common.SetContextKey(c, constant.ContextKeyTokenCrossGroupRetry, crossGroup)
		for _, id := range []int{31100, 31101, 31102} {
			RecordPolicyFailure(c, id, types.WithOpenAIError(types.OpenAIError{}, 400), PolicyDecision{Action: "retry"})
		}
		channel, group, err := CacheGetRandomSatisfiedChannel(&RetryParam{Ctx: c, TokenGroup: "auto", ModelName: modelName, Retry: common.GetPointer(1)})
		require.NoError(t, err)
		if crossGroup {
			require.NotNil(t, channel)
			assert.Equal(t, 31103, channel.Id)
			assert.Equal(t, "vip", group)
		} else {
			assert.Nil(t, channel, "cooldown filtering must not bypass disabled cross-group retries")
		}
	}
}

func TestChannelCooldownNeverReplaysPartialResponse(t *testing.T) {
	c := newChannelCooldownContext(t)
	_, err := c.Writer.WriteString("data: partial\n\n")
	require.NoError(t, err)
	decision := DecideRelayRetry(c, types.WithClaudeError(types.ClaudeError{Type: "overloaded_error"}, 503), 2)
	assert.Equal(t, "stop", decision.Action)
	assert.Equal(t, "response_already_started", decision.Reason)
}
