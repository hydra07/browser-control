package daemon

import "testing"

func TestNormalizeCommandName(t *testing.T) {
	if got := NormalizeCommandName("network-requests"); got != "network_requests" {
		t.Fatalf("NormalizeCommandName() = %q", got)
	}
	if !IsKnownCommand("network-requests") {
		t.Fatal("expected hyphenated server command alias to be known")
	}
}

func TestParsePayloadArgs(t *testing.T) {
	payload, err := ParsePayloadArgs([]string{
		`compact=true`,
		`limit=20`,
		`resourceTypes=["fetch","xhr"]`,
		`filter=api`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if payload["compact"] != true {
		t.Fatalf("compact = %#v", payload["compact"])
	}
	if payload["limit"].(float64) != 20 {
		t.Fatalf("limit = %#v", payload["limit"])
	}
	if payload["filter"] != "api" {
		t.Fatalf("filter = %#v", payload["filter"])
	}
}
