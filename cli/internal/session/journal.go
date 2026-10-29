package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

const (
	maxJournalBytes       = 16 * 1024 * 1024
	maxJournalRecordBytes = 64 * 1024
	journalIntent         = "intent"
	journalOutcome        = "outcome"
	journalAck            = "ack_unknown"
)

var ErrPendingAction = errors.New("pending_action: an earlier action requires verification before mutation")

type ActionScope struct {
	BrowserID string `json:"browserId"`
	TargetID  string `json:"targetId"`
}

type ActionIntent struct {
	ActionID  string            `json:"actionId"`
	Kind      driver.ActionKind `json:"kind"`
	StartedAt int64             `json:"startedAt"`
	Scope     ActionScope       `json:"scope"`
}

type ActionRecord struct {
	Seq uint64 `json:"seq"`
	ActionIntent
	Outcome             *driver.ActionResult `json:"outcome,omitempty"`
	AcknowledgedUnknown bool                 `json:"acknowledgedUnknown,omitempty"`
}

type journalWire struct {
	SchemaVersion int                  `json:"schemaVersion"`
	SessionID     string               `json:"sessionId"`
	Seq           uint64               `json:"seq"`
	Event         string               `json:"event"`
	Status        string               `json:"status,omitempty"`
	Intent        *ActionIntent        `json:"intent,omitempty"`
	Outcome       *driver.ActionResult `json:"outcome,omitempty"`
}

type Journal struct {
	store     *Store
	lock      *Lock
	path      string
	sessionID string
	size      int64
	records   []ActionRecord
	bySeq     map[uint64]int
	byID      map[string]bool
	err       error
	syncFile  func(*os.File) error
}

// OpenJournal requires the same session lock to stay held through dispatch and outcome persistence.
func (s *Store) OpenJournal(lock *Lock) (*Journal, error) {
	if lock == nil {
		return nil, errors.New("journal requires a live session lock")
	}
	lock.mu.Lock()
	defer lock.mu.Unlock()
	if lock.closed || filepath.Clean(lock.file.Name()) != filepath.Join(filepath.Dir(s.path), "session.lock") {
		return nil, errors.New("journal requires this session's live process lock")
	}
	if lock.journal != nil {
		return lock.journal, lock.journal.err
	}
	journal := &Journal{store: s, lock: lock, path: filepath.Join(filepath.Dir(s.path), "actions.jsonl"), sessionID: s.id, bySeq: map[uint64]int{}, byID: map[string]bool{}, syncFile: func(file *os.File) error { return file.Sync() }}
	if err := journal.load(); err != nil {
		return nil, err
	}
	lock.journal = journal
	return journal, nil
}

func (j *Journal) check() error {
	if j.lock.closed {
		return errors.New("journal process lock is released")
	}
	return j.err
}

func (j *Journal) Begin(ctx context.Context, intent ActionIntent) (ActionRecord, error) {
	j.lock.mu.Lock()
	defer j.lock.mu.Unlock()
	if err := j.check(); err != nil {
		return ActionRecord{}, err
	}
	return j.begin(ctx, intent)
}

func (j *Journal) begin(ctx context.Context, intent ActionIntent) (ActionRecord, error) {
	if err := ctx.Err(); err != nil {
		return ActionRecord{}, err
	}
	if !validIntent(intent) || j.byID[intent.ActionID] {
		return ActionRecord{}, errors.New("invalid or duplicate action intent")
	}
	if err := j.pending(); err != nil {
		return ActionRecord{}, err
	}
	seq := uint64(len(j.records)) + 1
	wire := journalWire{SchemaVersion: 1, SessionID: j.sessionID, Seq: seq, Event: journalIntent, Status: "dispatch_unknown", Intent: &intent}
	if err := j.append(wire); err != nil {
		return ActionRecord{}, err
	}
	record := ActionRecord{Seq: seq, ActionIntent: intent}
	j.bySeq[seq] = len(j.records)
	j.byID[intent.ActionID] = true
	j.records = append(j.records, record)
	return record, nil
}

func (j *Journal) Finish(seq uint64, result driver.ActionResult) error {
	j.lock.mu.Lock()
	defer j.lock.mu.Unlock()
	if err := j.check(); err != nil {
		return err
	}
	return j.finish(seq, result)
}

func (j *Journal) finish(seq uint64, result driver.ActionResult) error {
	index, ok := j.bySeq[seq]
	if !ok {
		return errors.New("outcome has no durable intent")
	}
	record := &j.records[index]
	if record.Outcome != nil || result.Validate() != nil || result.ActionID != record.ActionID || result.Kind != record.Kind || result.StartedAt != record.StartedAt {
		return errors.New("outcome does not match its unresolved intent")
	}
	if err := j.append(journalWire{SchemaVersion: 1, SessionID: j.sessionID, Seq: seq, Event: journalOutcome, Outcome: &result}); err != nil {
		return err
	}
	record.Outcome = cloneOutcome(&result)
	return nil
}

// Execute holds the session lock and always attempts J2 even when dispatch cancels its context.
func (j *Journal) Execute(ctx context.Context, scope ActionScope, kind driver.ActionKind, dispatch func(context.Context) (driver.ActionResult, error)) (result driver.ActionResult, err error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	result = driver.NewAction(kind)
	defer func() {
		if result.FinishedAt == 0 {
			result.FinishedAt = time.Now().UnixMilli()
		}
	}()
	if dispatch == nil {
		return result, errors.New("missing input dispatcher")
	}
	j.lock.mu.Lock()
	defer j.lock.mu.Unlock()
	if err := j.check(); err != nil {
		return result, err
	}
	intent := ActionIntent{ActionID: result.ActionID, Kind: kind, StartedAt: result.StartedAt, Scope: scope}
	if !validIntent(intent) {
		return result, errors.New("invalid action intent")
	}
	if err := j.pending(); err != nil {
		result.Status = driver.Blocked
		return result, err
	}
	if _, err := j.store.ClaimTab(ctx, scope.BrowserID, scope.TargetID, 5*time.Minute); err != nil {
		result.Status = driver.Blocked
		if ctx.Err() != nil {
			result.Status = driver.Cancelled
		}
		return result, err
	}
	record, err := j.begin(ctx, intent)
	if err != nil {
		if errors.Is(err, ErrPendingAction) {
			result.Status = driver.Blocked
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			result.Status = driver.Cancelled
		}
		return result, err
	}
	var dispatchErr error
	if dispatchErr = ctx.Err(); dispatchErr == nil {
		_, dispatchErr = j.store.ClaimTab(ctx, scope.BrowserID, scope.TargetID, 5*time.Minute)
	}
	if dispatchErr == nil {
		result, dispatchErr = dispatch(ctx)
		result.ActionID = intent.ActionID
		result.Kind = intent.Kind
		result.StartedAt = intent.StartedAt
	} else {
		result.Status = driver.Blocked
		if ctx.Err() != nil {
			result.Status = driver.Cancelled
		}
		result.FinishedAt = time.Now().UnixMilli()
	}
	if err := result.Validate(); err != nil {
		result.Status = driver.OutcomeUnknown
		return result, fmt.Errorf("outcome_not_recorded: action %s remains pending after invalid dispatcher result: %w", intent.ActionID, errors.Join(err, dispatchErr))
	}
	if err := j.finish(record.Seq, result); err != nil {
		return result, fmt.Errorf("outcome_not_recorded: action %s requires inspection; do not repeat input: %w", intent.ActionID, errors.Join(err, dispatchErr))
	}
	return result, dispatchErr
}

func (j *Journal) pending() error {
	for _, record := range j.records {
		if !record.AcknowledgedUnknown && (record.Outcome == nil || record.Outcome.Status == driver.OutcomeUnknown) {
			return fmt.Errorf("%w: %s", ErrPendingAction, record.ActionID)
		}
	}
	return nil
}

func (j *Journal) Records() ([]ActionRecord, error) {
	j.lock.mu.Lock()
	defer j.lock.mu.Unlock()
	if err := j.check(); err != nil {
		return nil, err
	}
	records := make([]ActionRecord, len(j.records))
	for i, record := range j.records {
		records[i] = record
		records[i].Outcome = cloneOutcome(record.Outcome)
	}
	return records, nil
}

func (j *Journal) Uncertain() ([]ActionRecord, error) {
	records, err := j.Records()
	if err != nil {
		return nil, err
	}
	uncertain := make([]ActionRecord, 0)
	for _, record := range records {
		if !record.AcknowledgedUnknown && (record.Outcome == nil || record.Outcome.Status == driver.OutcomeUnknown) {
			uncertain = append(uncertain, record)
		}
	}
	return uncertain, nil
}

func (j *Journal) AcknowledgeUnknown(ctx context.Context, actionID string) error {
	j.lock.mu.Lock()
	defer j.lock.mu.Unlock()
	if err := j.check(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	for i := range j.records {
		record := &j.records[i]
		if record.ActionID != actionID {
			continue
		}
		if record.AcknowledgedUnknown {
			return nil
		}
		if record.Outcome != nil && record.Outcome.Status != driver.OutcomeUnknown {
			return errors.New("action has a known outcome and does not require acknowledgement")
		}
		if err := j.append(journalWire{SchemaVersion: 1, SessionID: j.sessionID, Seq: record.Seq, Event: journalAck}); err != nil {
			return err
		}
		record.AcknowledgedUnknown = true
		return nil
	}
	return errors.New("unknown action ID")
}

func cloneOutcome(result *driver.ActionResult) *driver.ActionResult {
	if result == nil {
		return nil
	}
	cloned := *result
	if result.DispatchedAt != nil {
		timestamp := *result.DispatchedAt
		cloned.DispatchedAt = &timestamp
	}
	if result.BBox != nil {
		box := *result.BBox
		cloned.BBox = &box
	}
	return &cloned
}

func validIntent(intent ActionIntent) bool {
	return driver.ValidActionID(intent.ActionID) && intent.StartedAt > 0 && intent.StartedAt <= 9007199254740991 &&
		driver.ValidActionKind(intent.Kind) && targetKey.MatchString(intent.Scope.BrowserID) && targetKey.MatchString(intent.Scope.TargetID)
}

func (j *Journal) append(wire journalWire) error {
	data, err := json.Marshal(wire)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if len(data) > maxJournalRecordBytes || j.size+int64(len(data)) > maxJournalBytes {
		return errors.New("journal_full: checkpoint/compaction is required before more mutation")
	}
	file, err := os.OpenFile(j.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		j.err = err
		return err
	}
	info, err := file.Stat()
	if err == nil && info.Size() != j.size {
		err = errors.New("journal changed outside the held session lock")
	}
	if err == nil {
		var count int
		count, err = file.Write(data)
		if err == nil && count != len(data) {
			err = io.ErrShortWrite
		}
	}
	if err == nil {
		err = j.syncFile(file)
	}
	err = errors.Join(err, file.Close())
	if err != nil {
		j.err = err
		return err
	}
	j.size += int64(len(data))
	return nil
}

func (j *Journal) load() error {
	info, err := os.Lstat(j.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("journal must be a regular file")
	}
	file, err := os.Open(j.path)
	if err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(file, maxJournalBytes+1))
	err = errors.Join(err, file.Close())
	if err != nil {
		return err
	}
	if len(data) > maxJournalBytes {
		return errors.New("journal exceeds read budget")
	}
	committedEnd := bytes.LastIndexByte(data, '\n') + 1
	for _, line := range bytes.Split(data[:committedEnd], []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		if len(line) > maxJournalRecordBytes {
			return errors.New("journal record exceeds read budget")
		}
		var wire journalWire
		decoder := json.NewDecoder(bytes.NewReader(line))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&wire); err != nil {
			return fmt.Errorf("journal_corrupt: %w", err)
		}
		if decoder.Decode(new(any)) != io.EOF || wire.SchemaVersion != 1 || wire.SessionID != j.sessionID {
			return errors.New("journal_corrupt: invalid version, owner or trailing data")
		}
		switch wire.Event {
		case journalAck:
			index, ok := j.bySeq[wire.Seq]
			if !ok || wire.Intent != nil || wire.Outcome != nil || wire.Status != "" {
				return errors.New("journal_corrupt: acknowledgement without intent")
			}
			record := &j.records[index]
			if record.AcknowledgedUnknown || record.Outcome != nil && record.Outcome.Status != driver.OutcomeUnknown {
				return errors.New("journal_corrupt: invalid unknown-action acknowledgement")
			}
			record.AcknowledgedUnknown = true
		case journalIntent:
			if wire.Seq != uint64(len(j.records))+1 || wire.Intent == nil || wire.Outcome != nil || wire.Status != "dispatch_unknown" || !validIntent(*wire.Intent) || j.byID[wire.Intent.ActionID] {
				return errors.New("journal_corrupt: invalid intent sequence")
			}
			j.bySeq[wire.Seq] = len(j.records)
			j.byID[wire.Intent.ActionID] = true
			j.records = append(j.records, ActionRecord{Seq: wire.Seq, ActionIntent: *wire.Intent})
		case journalOutcome:
			index, ok := j.bySeq[wire.Seq]
			if !ok || wire.Outcome == nil || wire.Intent != nil || wire.Status != "" {
				return errors.New("journal_corrupt: outcome without intent")
			}
			record := &j.records[index]
			result := wire.Outcome
			if record.Outcome != nil || result.Validate() != nil || result.ActionID != record.ActionID || result.Kind != record.Kind || result.StartedAt != record.StartedAt {
				return errors.New("journal_corrupt: inconsistent outcome")
			}
			record.Outcome = result
		default:
			return errors.New("journal_corrupt: unsupported event")
		}
	}
	// A partial J2 cannot erase its fully committed J1. Never discard a malformed complete line.
	if committedEnd < len(data) {
		file, err := os.OpenFile(j.path, os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		err = file.Truncate(int64(committedEnd))
		if err == nil {
			err = file.Sync()
		}
		if err = errors.Join(err, file.Close()); err != nil {
			return err
		}
	}
	j.size = int64(committedEnd)
	return nil
}
