package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/privacy"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("check-fixtures", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", ".", "Git worktree directory (checks staged fixtures, without reading private working-tree files)")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(stderr, "usage: check-fixtures [-root <worktree>]")
		return 2
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	findings, err := privacy.CheckIndex(ctx, *root)
	if err != nil {
		fmt.Fprintln(stderr, "fixture privacy check failed:", err)
		return 1
	}
	if len(findings) > 0 {
		for _, finding := range findings {
			fmt.Fprintln(stderr, finding.String())
		}
		fmt.Fprintln(stderr, "fixture privacy check failed; remove private/captured files and redact credentials before staging again (docs/PRIVACY.md)")
		return 1
	}
	fmt.Fprintln(stdout, "ok: staged fixture privacy checks passed")
	return 0
}
