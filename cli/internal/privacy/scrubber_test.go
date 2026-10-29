package privacy

import (
	"strings"
	"testing"
)

func TestCaptureScrubberRedactsCredentialsButPreservesBusinessData(t *testing.T) {
	scrubber := NewScrubber([]string{"unique-password-value", "123456"})
	text := `Mai Nguyen mai@example.test ORD-42 password: unique-password-value; OTP: 123456; Bearer synthetic-sensitive-value https://example.test/orders?email=mai%40example.test&access_token=synthetic-token`
	clean := scrubber.Text(text)
	for _, secret := range []string{"unique-password-value", "123456", "synthetic-sensitive-value", "synthetic-token"} {
		if strings.Contains(clean, secret) {
			t.Fatal("capture scrubber leaked a credential")
		}
	}
	for _, business := range []string{"Mai Nguyen", "mai@example.test", "ORD-42"} {
		if !strings.Contains(clean, business) {
			t.Fatal("business data removed")
		}
	}
	if len(CheckFile("fixtures/public/capture.txt", []byte(clean))) != 0 {
		t.Fatal("scrubbed text failed privacy gate")
	}
}

func TestCaptureScrubberHandlesOverlapsAndNeverKeepsInlinePixels(t *testing.T) {
	scrubber := NewScrubber([]string{"password-value", "value"})
	if got := scrubber.Text("password-value"); got != Redacted {
		t.Fatalf("overlap left a credential fragment: %q", got)
	}
	if got := scrubber.URL("https://example.test/orders?orderId=ORD-42&token=hidden#secret"); strings.Contains(got, "hidden") || strings.Contains(got, "secret") || !strings.Contains(got, "ORD-42") {
		t.Fatal("URL policy failed")
	}
	if got := scrubber.URL("data:image/png;base64,private-pixels"); got != Redacted {
		t.Fatal("opaque URL escaped artifact policy")
	}
}
