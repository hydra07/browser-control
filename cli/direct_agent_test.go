package main

import (
	"strings"
	"testing"
)

func TestAgentKeyChordsApplyShiftWithoutChangingPhysicalKey(t *testing.T) {
	for _, test := range []struct{ chord, key, code string }{
		{"Shift+a", "A", "KeyA"},
		{"Shift+1", "!", "Digit1"},
		{"Shift+0", ")", "Digit0"},
		{"Control+a", "a", "KeyA"},
	} {
		keys, err := agentKeys(test.chord)
		if err != nil {
			t.Fatal(err)
		}
		last := keys[len(keys)-1]
		if last.Key != test.key || last.Code != test.code {
			t.Fatalf("%s: %+v", test.chord, last)
		}
	}
}

func TestDirectAgentCommandsAdvertiseWorkingRoute(t *testing.T) {
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "direct")
	for _, name := range []string{"open", "snapshot", "click", "type", "fill", "press", "tabs", "screenshot", "read", "wait", "scroll"} {
		code, stdout, stderr := runCLIProcess(t, name, "--help", "--json")
		if code != 0 {
			t.Fatalf("%s: %d %s %s", name, code, stdout, stderr)
		}
		help, _ := singleJSONResult(t, stdout)["help"].(string)
		if !strings.Contains(help, "browsercontrol direct "+name) || strings.Contains(help, "being migrated") {
			t.Fatalf("%s has no agent command help: %s", name, help)
		}
	}
}

func TestAgentInvalidOptionsFailBeforeBrowserStartup(t *testing.T) {
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "direct")
	for _, args := range [][]string{{"open", "ftp://example.test"}, {"open", "https://example.test", "--runs", "20"}, {"open", "https://example.test", "--full"}, {"click"}, {"press", "a+Control"}, {"press", "Control+Control"}, {"scroll", "NaN"}, {"tabs", "list", "extra"}, {"screenshot", "file.jpg"}, {"ack", "a_unknown"}} {
		code, stdout, stderr := runCLIProcess(t, append(args, "--json")...)
		if code != 2 || singleJSONResult(t, stdout)["error"] == nil {
			t.Fatalf("%v: %d %s %s", args, code, stdout, stderr)
		}
	}
}
