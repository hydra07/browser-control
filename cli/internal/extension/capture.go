package extension

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
)

const maxCaptureBytes = 256 * 1024 * 1024

type captureSink struct {
	file  *os.File
	path  string
	bytes int64
	err   error
}

func newCaptureSink() (*captureSink, error) {
	dir := filepath.Join(HomeDir(), "artifacts")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	file, err := os.CreateTemp(dir, "capture-*.webm")
	if err != nil {
		return nil, err
	}
	return &captureSink{file: file, path: file.Name()}, nil
}

func (c *captureSink) writePacket(packet []byte) error {
	if len(packet) < 8 || packet[0] != 0xbc || packet[1] != 0x01 || packet[2] != 0x02 || packet[3] != 0 || int(binary.LittleEndian.Uint32(packet[4:8])) != len(packet)-8 || len(packet)-8 > 8*1024*1024 {
		return fmt.Errorf("invalid capture binary frame")
	}
	if c.file == nil {
		return fmt.Errorf("capture is not open")
	}
	if c.bytes+int64(len(packet)-8) > maxCaptureBytes {
		c.err = fmt.Errorf("capture exceeded 256 MiB")
		return c.err
	}
	n, err := c.file.Write(packet[8:])
	c.bytes += int64(n)
	if err != nil {
		c.err = err
	}
	return err
}

func (c *captureSink) close() {
	if c.file == nil {
		return
	}
	if err := c.file.Sync(); err != nil && c.err == nil {
		c.err = err
	}
	if err := c.file.Close(); err != nil && c.err == nil {
		c.err = err
	}
	c.file = nil
}

func (c *captureSink) result(result map[string]any) {
	result["dataPath"], result["bytes"] = c.path, c.bytes
	if c.err != nil || c.bytes == 0 {
		result["success"] = false
		result["error"] = "Capture file is empty or incomplete; inspect dataPath"
		if c.err != nil {
			result["error"] = c.err.Error()
		}
	}
}
