package privacy

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"slices"
	"strconv"
	"strings"
)

const maxIndexBytes = 4 << 20
const maxTotalBytes = 256 << 20
const maxFixtureFiles = 10000

type indexedFixture struct{ name, oid string }

type boundedOutput struct {
	buffer bytes.Buffer
	limit  int
}

func (b *boundedOutput) Len() int      { return b.buffer.Len() }
func (b *boundedOutput) Bytes() []byte { return b.buffer.Bytes() }

func (b *boundedOutput) Write(data []byte) (int, error) {
	if len(data) > b.limit-b.Len() {
		return 0, errors.New("Git output exceeds fixture budget")
	}
	return b.buffer.Write(data)
}

func gitOutput(ctx context.Context, root string, limit int, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, "git", append([]string{"-C", root}, args...)...)
	out := &boundedOutput{limit: limit}
	command.Stdout = out
	if err := command.Run(); err != nil {
		return nil, errors.New("cannot read fixture Git index; use a Git worktree with readable index and blobs")
	}
	return out.Bytes(), nil
}

/** Reading index blobs also catches staged secrets hidden by later edits to the working tree. */
func CheckIndex(ctx context.Context, root string) ([]Finding, error) {
	resolved, err := gitOutput(ctx, root, 32768, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, err
	}
	root = strings.TrimSuffix(strings.TrimSuffix(string(resolved), "\n"), "\r")
	data, err := gitOutput(ctx, root, maxIndexBytes, "ls-files", "--stage", "--full-name", "-z", "--", "fixtures/")
	if err != nil {
		return nil, err
	}
	var findings []Finding
	var files []indexedFixture
	for _, entry := range bytes.Split(data, []byte{0}) {
		if len(entry) == 0 {
			continue
		}
		header, name, ok := strings.Cut(string(entry), "\t")
		fields := strings.Fields(header)
		if !ok || len(fields) != 3 || !validOID(fields[1]) {
			return nil, errors.New("invalid fixture index entry")
		}
		if rejected := checkPath(name); len(rejected) > 0 {
			findings = append(findings, rejected...)
		} else if fields[2] != "0" {
			findings = append(findings, Finding{Path: name, Code: "unmerged_fixture_index"})
		} else if fields[0] == "120000" {
			findings = append(findings, Finding{Path: name, Code: "symlink_forbidden"})
		} else if fields[0] != "100644" && fields[0] != "100755" {
			findings = append(findings, Finding{Path: name, Code: "fixture_mode_forbidden"})
		} else {
			files = append(files, indexedFixture{name: name, oid: fields[1]})
		}
		if len(files)+len(findings) > maxFixtureFiles {
			return nil, errors.New("fixture index exceeds file budget")
		}
		if len(findings) >= maxFindings {
			return limitedFindings(findings), nil
		}
	}
	if len(files) != 0 {
		more, err := checkBlobs(ctx, root, files)
		if err != nil {
			return nil, err
		}
		findings = append(findings, more...)
	}
	return limitedFindings(findings), nil
}

func checkBlobs(ctx context.Context, root string, files []indexedFixture) ([]Finding, error) {
	var input strings.Builder
	for _, file := range files {
		input.WriteString(file.oid)
		input.WriteByte('\n')
	}
	command := exec.CommandContext(ctx, "git", "-C", root, "cat-file", "--batch")
	command.Stdin = strings.NewReader(input.String())
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, errors.New("cannot open fixture object reader")
	}
	if err := command.Start(); err != nil {
		return nil, errors.New("cannot start fixture object reader")
	}
	defer func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	reader := bufio.NewReader(stdout)
	var findings []Finding
	var total int64
	for _, file := range files {
		header, err := reader.ReadString('\n')
		if err != nil || len(header) > 256 {
			return nil, errors.New("cannot read fixture object header")
		}
		fields := strings.Fields(header)
		if len(fields) != 3 || fields[0] != file.oid || fields[1] != "blob" {
			return nil, errors.New("invalid fixture object")
		}
		size, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil || size < 0 {
			return nil, errors.New("invalid fixture object size")
		}
		if size > maxFixtureBytes || size > maxTotalBytes-total {
			return append(findings, Finding{Path: file.name, Code: "fixture_byte_budget_exceeded"}), nil
		}
		total += size
		data := make([]byte, int(size))
		if _, err := io.ReadFull(reader, data); err != nil {
			return nil, errors.New("cannot read fixture object")
		}
		if separator, err := reader.ReadByte(); err != nil || separator != '\n' {
			return nil, errors.New("invalid fixture object boundary")
		}
		findings = append(findings, CheckFile(file.name, data)...)
		if len(findings) >= maxFindings {
			return limitedFindings(findings), nil
		}
	}
	if err := command.Wait(); err != nil {
		return nil, errors.New("fixture object reader failed")
	}
	return findings, nil
}

func validOID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, char := range value {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}

func limitedFindings(findings []Finding) []Finding {
	slices.SortFunc(findings, func(a, b Finding) int {
		return strings.Compare(fmt.Sprintf("%s:%09d:%s", a.Path, a.Line, a.Code), fmt.Sprintf("%s:%09d:%s", b.Path, b.Line, b.Code))
	})
	findings = slices.Compact(findings)
	if len(findings) > maxFindings {
		findings = append(findings[:maxFindings-1], Finding{Path: "fixtures/", Code: "finding_limit_exceeded"})
	}
	return findings
}
