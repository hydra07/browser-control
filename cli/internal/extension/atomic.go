package extension

import (
	"io"
	"os"
	"path/filepath"

	"github.com/hydra07/browsercontrol/cli/internal/statefile"
)

func CopyFileAtomic(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	output, err := os.CreateTemp(filepath.Dir(destination), ".bc-copy-*")
	if err != nil {
		return err
	}
	defer os.Remove(output.Name())
	_, err = io.Copy(output, input)
	if err == nil {
		err = output.Sync()
	}
	closeErr := output.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(output.Name(), destination)
}

// WriteFileAtomic keeps readers from observing partially written state or flows.
func WriteFileAtomic(path string, data []byte) error {
	return statefile.WriteAtomic(path, data)
}
