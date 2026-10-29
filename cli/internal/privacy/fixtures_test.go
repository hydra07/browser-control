package privacy

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestClassificationKeepsBusinessDataDistinctFromCredentials(t *testing.T) {
	for _, name := range []string{"password", "access_token", "api-key", "sessionId", "one-time-code", "cc-number", "creditCardNumber", "CVV", "Authorization", "AWS_SECRET_ACCESS_KEY"} {
		if ClassifyField(name) != Secret {
			t.Errorf("credential field %q not secret", name)
		}
	}
	for _, name := range []string{"email", "fullName", "address", "orderId"} {
		if ClassifyField(name) != Business {
			t.Errorf("business field %q was over-redacted", name)
		}
	}
	if ClassifyField("role") != Ordinary {
		t.Fatal("structural metadata must remain usable")
	}
}

func TestFixtureURLRemovesCredentialsButRetainsBusinessQueries(t *testing.T) {
	got, err := SanitizeURL("https://user:pass@example.test/orders?email=mai%40example.test&orderId=ORD-42&%61ccess_token=synthetic-sensitive-value&API-Key=synthetic-key#access_token=fragment-value")
	if err != nil || got != "https://example.test/orders?email=mai%40example.test&orderId=ORD-42" {
		t.Fatalf("unexpected sanitized URL: %q %v", got, err)
	}
	for _, raw := range []string{"javascript:secret-value", "https://example.test/?token=%xx"} {
		if _, err := SanitizeURL(raw); err == nil || strings.Contains(err.Error(), "secret-value") {
			t.Fatal("bad URL must fail without echoing input")
		}
	}
}

func TestPublicFixtureChecksSecretsWithoutRemovingBusinessData(t *testing.T) {
	good := []byte(`{"url":"https://example.test/orders?orderId=ORD-42&email=mai%40example.test","name":"Mai Nguyen","email":"mai@example.test","address":"12 Example Street","orderId":"ORD-42","password":"[REDACTED]","token":null,"nodes":[{"name":"Password","value":{"type":"string","value":"[REDACTED]"}}]}`)
	if findings := CheckFile("fixtures/public/orders.json", good); len(findings) != 0 {
		t.Fatalf("public business data rejected: %v", findings)
	}
	for _, content := range []string{
		`{"password":"synthetic-sensitive-value"}`,
		`{"access_token":"synthetic-sensitive-value"}`,
		`{"headers":[{"name":"Authorization","value":"synthetic-sensitive-value"}]}`,
		`{"nodes":[{"name":"Password","value":{"type":"string","value":"synthetic-sensitive-value"}}]}`,
		`{"type":"password","value":"synthetic-sensitive-value"}`,
		`{"autocomplete":"one-time-code","value":"123456"}`,
		`{"cookies":[]}`,
		`{"localStorage":{}}`,
		`{"sessionStorage":{}}`,
		`{"url":"https://example.test/?access_token=synthetic-sensitive-value"}`,
		`{"url":"https://example.test/?%61pi_key=synthetic-sensitive-value"}`,
		`{"value":"Bearer synthetic-sensitive-value"}`,
		`{"value":"-----BEGIN PRIVATE KEY-----"}`,
		`{"value":"ghp_123456789012345678901234567890"}`,
		`{"value":"AKIA1234567890ABCDEF"}`,
		`{"value":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGljc2lnbmF0dXJl"}`,
		`{"secret":"synthetic-sensitive-value"`,
		`{"token":null} {"token":"synthetic-sensitive-value"}`,
	} {
		if findings := CheckFile("fixtures/public/orders.json", []byte(content)); len(findings) == 0 {
			t.Error("unsafe fixture was accepted")
		}
	}
}

func TestHTMLAndTextFixturesCannotBypassTheJSONBoundary(t *testing.T) {
	for _, content := range []string{
		`<input type="password" value="synthetic-sensitive-value">`,
		`<input value="synthetic-sensitive-value" autocomplete="one-time-code">`,
		`<input name="api_key" value="synthetic-sensitive-value">`,
		`<a href="https://example.test/?email=mai@example.test&amp;access_token=synthetic-sensitive-value">Open</a>`,
		`password: synthetic-sensitive-value`,
		`session_id = synthetic-sensitive-value`,
		`card number: 4111 1111 1111 1111`,
	} {
		if findings := CheckFile("fixtures/synthetic/form.html", []byte(content)); len(findings) == 0 {
			t.Error("unsafe HTML/text accepted")
		}
	}
	for _, content := range []string{
		`<input type="password" value="[REDACTED]">`,
		`<input name="email" value="mai@example.test"><p>Mai Nguyen · ORD-42</p>`,
		`Password: [REDACTED]`,
	} {
		if findings := CheckFile("fixtures/synthetic/form.html", []byte(content)); len(findings) != 0 {
			t.Fatalf("safe HTML rejected: %v", findings)
		}
	}
}

func TestFixturePathsAndBinaryCapturesAreRefused(t *testing.T) {
	for _, path := range []string{"fixtures/private/page.json", "fixtures/public/private/page.json", "fixtures/local/page.json", "fixtures/page.json", "fixtures/public/cookies.json", "fixtures/public/page.png", "fixtures/public/page.har", "../fixtures/public/page.json"} {
		if len(CheckFile(path, []byte(`{}`))) == 0 {
			t.Errorf("unsafe path accepted: %s", path)
		}
	}
	if len(CheckFile("fixtures/public/page.txt", []byte{0, 255, 0})) == 0 {
		t.Fatal("binary disguised as text was accepted")
	}
}

func fixtureRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	git(t, root, "init", "-q")
	return root
}

func git(t *testing.T, root string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git fixture setup failed: %v %s", err, output)
	}
}

func stageFixture(t *testing.T, root, path, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	git(t, root, "add", "-f", "--", path)
}

func TestIndexGuardReadsStagedBlobRatherThanTheWorkingTree(t *testing.T) {
	root := fixtureRepo(t)
	path := "fixtures/public/form.json"
	stageFixture(t, root, path, `{"password":"synthetic-sensitive-value"}`)
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(path)), []byte(`{"password":"[REDACTED]"}`), 0600); err != nil {
		t.Fatal(err)
	}
	findings, err := CheckIndex(context.Background(), root)
	if err != nil || len(findings) == 0 {
		t.Fatalf("staged credential missed: %v %v", findings, err)
	}
	for _, finding := range findings {
		if strings.Contains(finding.String(), "synthetic-sensitive-value") {
			t.Fatal("guard leaked fixture data in diagnostic")
		}
	}
}

func TestIndexGuardRejectsForcedPrivateFilesButIgnoresUntrackedPrivateData(t *testing.T) {
	root := fixtureRepo(t)
	stageFixture(t, root, "fixtures/public/orders.json", `{"name":"Mai Nguyen","email":"mai@example.test","orderId":"ORD-42"}`)
	private := filepath.Join(root, "fixtures", "private")
	if err := os.MkdirAll(private, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(private, "page.json"), []byte(`{"password":"synthetic-sensitive-value"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if findings, err := CheckIndex(context.Background(), root); err != nil || len(findings) != 0 {
		t.Fatalf("untracked private data read: %v %v", findings, err)
	}
	git(t, root, "add", "-f", "--", "fixtures/private/page.json")
	if findings, err := CheckIndex(context.Background(), root); err != nil || len(findings) == 0 {
		t.Fatalf("forced private fixture missed: %v %v", findings, err)
	}
}

func TestIndexGuardRejectsSymlinksAndRedactsSecretFilenames(t *testing.T) {
	root := fixtureRepo(t)
	path := "fixtures/public/token=synthetic-sensitive-value.json"
	stageFixture(t, root, path, `{}`)
	findings, err := CheckIndex(context.Background(), root)
	if err != nil || len(findings) == 0 {
		t.Fatalf("secret filename accepted: %v", err)
	}
	for _, finding := range findings {
		if strings.Contains(finding.String(), "synthetic-sensitive-value") {
			t.Fatal("filename secret leaked")
		}
	}
	git(t, root, "update-index", "--add", "--cacheinfo", "120000,"+hashBlob(t, root, "outside-profile")+",fixtures/public/link.txt")
	if findings, err := CheckIndex(context.Background(), root); err != nil || !hasCode(findings, "symlink_forbidden") {
		t.Fatalf("index symlink accepted: %v %v", findings, err)
	}
}

func hashBlob(t *testing.T, root, value string) string {
	t.Helper()
	cmd := exec.Command("git", "-C", root, "hash-object", "-w", "--stdin")
	cmd.Stdin = strings.NewReader(value)
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

func hasCode(findings []Finding, code string) bool {
	for _, finding := range findings {
		if finding.Code == code {
			return true
		}
	}
	return false
}
