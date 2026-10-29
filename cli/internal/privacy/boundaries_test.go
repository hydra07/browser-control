package privacy

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRepositoryFixtureSeedsFollowThePolicy(t *testing.T) {
	for _, name := range []string{"fixtures/README.md", "fixtures/synthetic/business-data.json"} {
		data, err := os.ReadFile(filepath.Join("..", "..", "..", filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		if findings := CheckFile(name, data); len(findings) != 0 {
			t.Fatalf("seed violates policy: %v", findings)
		}
	}
}

func TestBusinessTextAndRedactedMessagesDoNotLookLikeCredentials(t *testing.T) {
	for _, content := range []string{
		`{"description":"Basic information for Mai Nguyen","message":"Password: [REDACTED]"}`,
		`{"description":"Bearer certificates","email":"mai@example.test"}`,
		`{"url":"https://example.test/orders?orderId=ORD-42&email=mai%40example.test"}`,
	} {
		if findings := CheckFile("fixtures/public/article.json", []byte(content)); len(findings) != 0 {
			t.Fatalf("business text rejected: %v", findings)
		}
	}
}

func TestEncodedAndProtectedFieldsCannotHideSecrets(t *testing.T) {
	for _, content := range []string{
		`{"\u0070assword":"synthetic-sensitive-value"}`,
		`{"password":"synthetic-sensitive-value","password":"[REDACTED]"}`,
		`{"password":false}`,
		`{"text":"password: null"}`,
		`{"text":"password: false"}`,
		`{"name":{"type":"computedString","value":"Password"},"value":{"type":"string","value":"synthetic-sensitive-value"}}`,
		`{"properties":[{"name":"protected","value":{"type":"boolean","value":true}}],"value":{"type":"string","value":"synthetic-sensitive-value"}}`,
		`{"text":"password\u003a synthetic-sensitive-value"}`,
		`{"text":"Basic c3ludGhldGljOnNlY3JldA=="}`,
		`{"text":"https:\/\/user:synthetic-sensitive-value@example.test\/orders"}`,
		`{"dataBase64":"c3ludGhldGlj"}`,
	} {
		if len(CheckFile("fixtures/public/form.json", []byte(content))) == 0 {
			t.Error("encoded/protected fixture accepted")
		}
	}
	if len(CheckFile("fixtures/synthetic/form.html", []byte(`<textarea name="otp">123456</textarea>`))) == 0 {
		t.Fatal("secret textarea content accepted")
	}
	for _, name := range []string{"fixtures/synthetic/page.html", "fixtures/public/page.svg"} {
		if len(CheckFile(name, []byte(`<svg><image href="data:image/png;base64,c3ludGhldGlj"/></svg>`))) == 0 {
			t.Fatal("inline pixels bypassed artifact policy")
		}
	}
}

func TestFixtureBudgetsAreEnforcedWithoutPartialSuccess(t *testing.T) {
	if !hasCode(CheckFile("fixtures/public/page.txt", []byte(strings.Repeat("x", maxFixtureBytes+1))), "fixture_too_large") {
		t.Fatal("byte budget ignored")
	}
	deep := strings.Repeat("[", 130) + "0" + strings.Repeat("]", 130)
	if !hasCode(CheckFile("fixtures/public/page.json", []byte(deep)), "invalid_fixture_json") {
		t.Fatal("nesting budget ignored")
	}
	root := fixtureRepo(t)
	stageFixture(t, root, "fixtures/public/page.txt", strings.Repeat("x", maxFixtureBytes+1))
	findings, err := CheckIndex(context.Background(), root)
	if err != nil || !hasCode(findings, "fixture_byte_budget_exceeded") {
		t.Fatalf("oversized staged blob accepted: %v %v", findings, err)
	}
	out := &boundedOutput{limit: 4}
	if _, err := io.Copy(out, strings.NewReader("too large")); err == nil || out.Len() > 4 {
		t.Fatal("Git output budget bypassed through io.Copy")
	}
}

func TestGuardDoesNotPrintURLCredentialsFromFilenames(t *testing.T) {
	findings := CheckFile("fixtures/public/https://user:synthetic-sensitive-value@example.test/file.json", []byte(`{}`))
	if len(findings) == 0 {
		t.Fatal("unsafe filename accepted")
	}
	for _, finding := range findings {
		if strings.Contains(finding.String(), "synthetic-sensitive-value") {
			t.Fatal("URL credentials echoed from filename")
		}
	}
}
