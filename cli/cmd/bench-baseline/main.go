package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/bench/baseline"
)

func main() {
	var config baseline.Config
	flag.StringVar(&config.Root, "root", "..", "repository root")
	flag.StringVar(&config.Chrome, "chrome", "", "Chrome for Testing executable")
	flag.StringVar(&config.Source, "source", "", "isolated archived original source")
	flag.StringVar(&config.Bridge, "bridge", "", "original CLI executable")
	flag.StringVar(&config.Extension, "extension", "", "original extension build with endpoint-only patch")
	flag.StringVar(&config.Archive, "archive", "", "original Git archive")
	flag.StringVar(&config.Output, "out", "", "new report JSON path; existing files are not overwritten")
	flag.IntVar(&config.Port, "port", 55861, "exclusive bridge endpoint matching the isolated extension build")
	flag.IntVar(&config.Runs, "runs", 10, "samples per scenario, at least 10")
	flag.IntVar(&config.CommandsPerSample, "commands", 20, "independent snapshot processes per query sample")
	flag.DurationVar(&config.IdleWindow, "idle", 2*time.Second, "idle sample window, at least one second")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	if err := baseline.Run(ctx, config, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "baseline:", err)
		os.Exit(1)
	}
}
