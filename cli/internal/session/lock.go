package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Lock struct {
	file    *os.File
	once    sync.Once
	err     error
	mu      sync.Mutex
	closed  bool
	journal *Journal
}

func (s *Store) Acquire(ctx context.Context) (*Lock, error) {
	return acquireLock(ctx, filepath.Join(filepath.Dir(s.path), "session.lock"))
}

func acquireLock(ctx context.Context, path string) (*Lock, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	locked := false
	defer func() {
		if !locked {
			_ = file.Close()
		}
	}()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		acquired, err := tryLock(file)
		if err != nil {
			return nil, fmt.Errorf("lock session: %w", err)
		}
		if acquired {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
	lock := &Lock{file: file}
	locked = true
	hostname, err := os.Hostname()
	if err == nil {
		var data []byte
		data, err = json.Marshal(struct {
			PID        int       `json:"pid"`
			Hostname   string    `json:"hostname"`
			AcquiredAt time.Time `json:"acquiredAt"`
		}{os.Getpid(), hostname, time.Now().UTC()})
		if err == nil {
			err = file.Truncate(0)
		}
		if err == nil {
			_, err = file.WriteAt(append(data, '\n'), 0)
		}
		if err == nil {
			err = file.Sync()
		}
	}
	if err != nil {
		_ = lock.Close()
		return nil, err
	}
	return lock, nil
}

// Close leaves the lock inode in place so another process cannot lock a replacement file.
func (l *Lock) Close() error {
	l.once.Do(func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.closed = true
		unlockErr := unlock(l.file)
		l.err = l.file.Close()
		if unlockErr != nil {
			l.err = unlockErr
		}
	})
	return l.err
}
