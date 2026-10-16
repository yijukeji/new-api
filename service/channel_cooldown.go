package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/google/uuid"
)

const channelCooldownContextKey = "channel_cooldown_probes"
const channelProbeLease = time.Minute
const channelCircuitRetention = 24 * time.Hour

type channelCircuitState struct {
	until   time.Time
	expires time.Time
	owner   string
}

type channelCircuitStore struct {
	mu     sync.Mutex
	states map[int]channelCircuitState
	now    func() time.Time
	sweep  time.Time
}

var channelCircuits = &channelCircuitStore{states: make(map[int]channelCircuitState), now: time.Now}

// Redis time and owner tokens make probe admission and completion atomic
// across replicas. A late success cannot erase a newer failure.
var channelCircuitScript = redis.NewScript(`
local tm = redis.call('TIME')
local now = tonumber(tm[1]) * 1000 + math.floor(tonumber(tm[2]) / 1000)
local op, owner = ARGV[1], ARGV[2]
local duration, retention = tonumber(ARGV[3]), tonumber(ARGV[4])
if op == 'reset' then return redis.call('DEL', KEYS[1]) end
if op == 'fail' then
  redis.call('HSET', KEYS[1], 'until', now + duration, 'owner', '')
  redis.call('PEXPIRE', KEYS[1], duration + retention)
  return 1
end
local untilAt = redis.call('HGET', KEYS[1], 'until')
if not untilAt then
  if op == 'acquire' then return 1 end
  return 0
end
if op == 'acquire' then
  if tonumber(untilAt) > now then return 0 end
  redis.call('HSET', KEYS[1], 'until', now + duration, 'owner', owner)
  redis.call('PEXPIRE', KEYS[1], retention)
  return 2
end
if redis.call('HGET', KEYS[1], 'owner') ~= owner or owner == '' then return 0 end
if op == 'success' then
  redis.call('DEL', KEYS[1])
elseif op == 'renew' then
  redis.call('HSET', KEYS[1], 'until', now + duration)
  redis.call('PEXPIRE', KEYS[1], retention)
elseif op == 'release' then
  redis.call('HSET', KEYS[1], 'until', now, 'owner', '')
end
return 1
`)

func (s *channelCircuitStore) transition(client *redis.Client, channelID int, op, owner string, duration time.Duration) (int, error) {
	if client != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		return channelCircuitScript.Run(ctx, client, []string{fmt.Sprintf("channel_circuit:v1:%d", channelID)}, op, owner, duration.Milliseconds(), channelCircuitRetention.Milliseconds()).Int()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if !now.Before(s.sweep) {
		for id, state := range s.states {
			if !now.Before(state.expires) {
				delete(s.states, id)
			}
		}
		s.sweep = now.Add(time.Hour)
	}
	state, found := s.states[channelID]
	if found && !now.Before(state.expires) {
		delete(s.states, channelID)
		found = false
	}
	if op == "fail" {
		s.states[channelID] = channelCircuitState{until: now.Add(duration), expires: now.Add(duration + channelCircuitRetention)}
		return 1, nil
	}
	if op == "reset" {
		delete(s.states, channelID)
		if found {
			return 1, nil
		}
		return 0, nil
	}
	if op == "acquire" {
		if !found {
			return 1, nil
		}
		if now.Before(state.until) {
			return 0, nil
		}
		state.until, state.owner, state.expires = now.Add(duration), owner, now.Add(channelCircuitRetention)
		s.states[channelID] = state
		return 2, nil
	}
	if !found || owner == "" || state.owner != owner {
		return 0, nil
	}
	switch op {
	case "success":
		delete(s.states, channelID)
	case "renew":
		state.until, state.expires = now.Add(duration), now.Add(channelCircuitRetention)
		s.states[channelID] = state
	case "release":
		state.until, state.owner = now, ""
		s.states[channelID] = state
	}
	return 1, nil
}

// ResetChannelCooldown clears only the temporary circuit, not the channel status.
func ResetChannelCooldown(channelID int) (bool, error) {
	if channelID <= 0 {
		return false, errors.New("invalid channel ID")
	}
	var client *redis.Client
	if common.RedisEnabled {
		client = common.RDB
		if client == nil {
			return false, errors.New("channel health state unavailable")
		}
	}
	changed, err := channelCircuits.transition(client, channelID, "reset", "", 0)
	return changed == 1, err
}

// GetChannelCooldowns batches state reads without admitting recovery probes.
// A circuit awaiting a successful probe is still considered active.
func GetChannelCooldowns(channelIDs []int) (map[int]bool, error) {
	states := make(map[int]bool, len(channelIDs))
	if len(channelIDs) == 0 {
		return states, nil
	}
	if common.RedisEnabled {
		if common.RDB == nil {
			return nil, errors.New("channel health state unavailable")
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		pipe := common.RDB.Pipeline()
		defer pipe.Close()
		commands := make(map[int]*redis.IntCmd, len(channelIDs))
		for _, id := range channelIDs {
			commands[id] = pipe.Exists(ctx, fmt.Sprintf("channel_circuit:v1:%d", id))
		}
		if _, err := pipe.Exec(ctx); err != nil {
			return nil, err
		}
		for id, command := range commands {
			states[id] = command.Val() != 0
		}
		return states, nil
	}
	channelCircuits.mu.Lock()
	defer channelCircuits.mu.Unlock()
	now := channelCircuits.now()
	for _, id := range channelIDs {
		state, found := channelCircuits.states[id]
		states[id] = found && now.Before(state.expires)
	}
	return states, nil
}

type channelProbe struct {
	store     *channelCircuitStore
	client    *redis.Client
	channelID int
	owner     string
	cancel    context.CancelFunc
	done      chan struct{}
}

func (p *channelProbe) renew(ctx context.Context) {
	defer close(p.done)
	ticker := time.NewTicker(channelProbeLease / 3)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			ok, err := p.store.transition(p.client, p.channelID, "renew", p.owner, channelProbeLease)
			if err == nil && ok == 0 {
				return
			}
		}
	}
}

// Healthy channels remain unrestricted; only recovery probes need a lease.
func acquireChannelProbe(c *gin.Context, channelID int) (bool, error) {
	if common.ChannelFailureCooldownSeconds == 0 || c == nil || channelID <= 0 {
		return true, nil
	}
	if c.Request != nil && c.Request.Context().Err() != nil {
		return false, c.Request.Context().Err()
	}
	var client *redis.Client
	if common.RedisEnabled {
		client = common.RDB
	}
	owner := uuid.NewString()
	result, err := channelCircuits.transition(client, channelID, "acquire", owner, channelProbeLease)
	if err != nil {
		common.SysError(common.LogText("channel cooldown admission failed: channel=%d error=%v", channelID, err))
		return false, errors.New("channel health state unavailable")
	}
	if result != 2 {
		return result == 1, nil
	}
	parent := context.Background()
	if c.Request != nil {
		parent = c.Request.Context()
	}
	ctx, cancel := context.WithCancel(parent)
	probe := &channelProbe{store: channelCircuits, client: client, channelID: channelID, owner: owner, cancel: cancel, done: make(chan struct{})}
	var probes []*channelProbe
	if value, exists := c.Get(channelCooldownContextKey); exists {
		probes = value.([]*channelProbe)
	}
	c.Set(channelCooldownContextKey, append(probes, probe))
	go probe.renew(ctx)
	return true, nil
}

func finishChannelProbe(c *gin.Context, channelID int, success bool) {
	if c == nil {
		return
	}
	value, exists := c.Get(channelCooldownContextKey)
	if !exists {
		return
	}
	probes := value.([]*channelProbe)
	remaining := make([]*channelProbe, 0, len(probes))
	for _, probe := range probes {
		if channelID != 0 && probe.channelID != channelID {
			remaining = append(remaining, probe)
			continue
		}
		probe.cancel()
		<-probe.done
		op := "release"
		if success {
			op = "success"
		}
		if _, err := probe.store.transition(probe.client, probe.channelID, op, probe.owner, 0); err != nil {
			common.SysError(common.LogText("channel cooldown completion failed: channel=%d error=%v", probe.channelID, err))
		}
	}
	c.Set(channelCooldownContextKey, remaining)
}

// ReleaseChannelProbes covers validation failures and cancellation before a
// relay result. It never marks an untested channel healthy.
func ReleaseChannelProbes(c *gin.Context) {
	finishChannelProbe(c, 0, false)
}

func channelFailureNeedsCooldown(c *gin.Context, apiErr *types.NewAPIError) bool {
	if apiErr == nil || errors.Is(apiErr, context.Canceled) || c != nil && c.Request != nil && c.Request.Context().Err() != nil {
		return false
	}
	if apiErr.GetErrorCode() == types.ErrorCodeDoRequestFailed {
		var networkErr net.Error
		return errors.As(apiErr, &networkErr) || errors.Is(apiErr, io.EOF) || errors.Is(apiErr, io.ErrUnexpectedEOF)
	}
	if apiErr.GetErrorType() == types.ErrorTypeNewAPIError && apiErr.GetErrorCode() != types.ErrorCodeBadResponseStatusCode {
		return false
	}
	if claudeErr, ok := apiErr.RelayError.(types.ClaudeError); ok && claudeErr.Type == "overloaded_error" {
		return true
	}
	if upstreamErr, ok := apiErr.RelayError.(types.OpenAIError); ok && (upstreamErr.Type == "overloaded_error" || upstreamErr.Code == "overloaded_error") {
		return true
	}
	switch apiErr.StatusCode {
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout, 529:
		return true
	}
	return false
}

func recordChannelCooldown(c *gin.Context, channelID int, apiErr *types.NewAPIError) bool {
	if channelID <= 0 || common.ChannelFailureCooldownSeconds == 0 || !channelFailureNeedsCooldown(c, apiErr) {
		finishChannelProbe(c, channelID, false)
		return false
	}
	var client *redis.Client
	if common.RedisEnabled {
		client = common.RDB
	}
	_, err := channelCircuits.transition(client, channelID, "fail", "", time.Duration(common.ChannelFailureCooldownSeconds)*time.Second)
	finishChannelProbe(c, channelID, false)
	if err != nil {
		common.SysError(common.LogText("channel cooldown failure update failed: channel=%d error=%v", channelID, err))
		return false
	}
	common.SysLog(common.LogText("channel cooldown started: channel=%d seconds=%d status=%d", channelID, common.ChannelFailureCooldownSeconds, apiErr.StatusCode))
	return true
}
