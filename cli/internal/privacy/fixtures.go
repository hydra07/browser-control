package privacy

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

const maxFixtureBytes = 16 << 20
const maxFindings = 100
const maxJSONNodes = 200000

type Finding struct {
	Path string `json:"path"`
	Line int    `json:"line,omitempty"`
	Code string `json:"code"`
}

func (f Finding) String() string {
	if f.Line > 0 {
		return fmt.Sprintf("%q:%d: %s", f.Path, f.Line, f.Code)
	}
	return fmt.Sprintf("%q: %s", f.Path, f.Code)
}

var secretAssignment = regexp.MustCompile(`(?i)\b(password|passwd|pwd|passphrase|secret|client[ _.-]*secret|(?:access|refresh|id|auth|oauth)[ _.-]*token|token|api[ _.-]*key|authorization|session[ _.-]*(?:id|token)|otp|totp|one[ _.-]*time[ _.-]*(?:code|password)|verification[ _.-]*code|card[ _.-]*(?:number|no)|cc[ _.-]*(?:number|csc)|cvv|cvc|pin)["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s<>,;}"']+))`)
var tokenPatterns = []*regexp.Regexp{
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b`),
	regexp.MustCompile(`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----`),
}
var bearerPattern = regexp.MustCompile(`(?i)\bBearer\s+([A-Za-z0-9_./+=-]{8,})`)
var basicPattern = regexp.MustCompile(`(?i)\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})`)
var urlPattern = regexp.MustCompile(`https?://[^\s<>"'` + "`" + `{}]+`)
var dataURIPattern = regexp.MustCompile(`(?i)\bdata:[^,\s"'<>]{0,128},`)
var controlStart = regexp.MustCompile(`(?is)<(?:input|textarea|select)\b`)
var controlTag = regexp.MustCompile(`(?is)<(?:input|textarea|select)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>`)
var attribute = regexp.MustCompile(`(?is)([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
var forbiddenFields = fieldSet("cookies localstorage sessionstorage indexeddb storagestate")

func CheckFile(name string, data []byte) []Finding {
	findings := checkPath(name)
	if len(findings) != 0 {
		return findings
	}
	add := func(code string, line int) {
		if len(findings) < maxFindings {
			findings = append(findings, Finding{Path: name, Line: line, Code: code})
		}
	}
	if len(data) > maxFixtureBytes {
		add("fixture_too_large", 0)
		return findings
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		add("binary_fixture_forbidden", 0)
		return findings
	}
	text := html.UnescapeString(string(data))
	if at := dataURIPattern.FindStringIndex(text); at != nil {
		add("inline_capture_forbidden", lineAt(text, at[0]))
	}
	for _, at := range credentialPositions(text) {
		add("secret_pattern", lineAt(text, at))
	}
	for _, match := range secretAssignment.FindAllStringSubmatchIndex(text, maxFindings) {
		value, unquoted := assignmentValue(text, match)
		if unsafeAssignment(value, unquoted && strings.ToLower(path.Ext(name)) == ".json") {
			add("secret_assignment", lineAt(text, match[0]))
		}
	}
	for _, match := range urlPattern.FindAllStringIndex(text, maxJSONNodes) {
		_, changed, err := sanitizeURL(strings.TrimRight(text[match[0]:match[1]], ".,;)"))
		if err != nil || changed {
			add("unsafe_fixture_url", lineAt(text, match[0]))
		}
	}
	if strings.ToLower(path.Ext(name)) == ".json" {
		value, err := decodeFixture(data)
		if err != nil {
			add("invalid_fixture_json", 0)
			return findings
		}
		inspectJSON(value, func(code string) { add(code, 0) })
	} else {
		inspectControls(text, add)
	}
	return findings
}

func checkPath(name string) []Finding {
	display := name
	if hasSecretPattern(name) || hasUnsafeURL(name) {
		display = "fixtures/[redacted path]"
	}
	fail := func(code string) []Finding { return []Finding{{Path: display, Code: code}} }
	if display != name {
		return fail("secret_filename")
	}
	if !strings.HasPrefix(name, "fixtures/") || path.Clean(name) != name || strings.Contains(name, "\\") {
		return fail("invalid_fixture_path")
	}
	parts := strings.Split(strings.ToLower(name), "/")
	for _, part := range parts {
		for _, reserved := range []string{"private", "local", ".private", ".local", "secrets"} {
			if part == reserved || strings.HasPrefix(part, reserved+"-") || strings.HasPrefix(part, reserved+"_") {
				return fail("private_fixture_forbidden")
			}
		}
	}
	if name != "fixtures/README.md" && (len(parts) < 3 || (parts[1] != "public" && parts[1] != "synthetic")) {
		return fail("unclassified_fixture")
	}
	ext := strings.ToLower(path.Ext(name))
	if !map[string]bool{".json": true, ".html": true, ".txt": true, ".md": true, ".svg": true}[ext] {
		return fail("fixture_format_forbidden")
	}
	if forbiddenFields[normalizedField(strings.TrimSuffix(path.Base(name), path.Ext(name)))] {
		return fail("browser_storage_forbidden")
	}
	return nil
}

func hasSecretPattern(text string) bool {
	for _, match := range secretAssignment.FindAllStringSubmatchIndex(text, maxFindings) {
		if value, _ := assignmentValue(text, match); !masked(value) {
			return true
		}
	}
	return len(credentialPositions(text)) > 0
}

func unsafeAssignment(value string, unquoted bool) bool {
	return !masked(value) && !(unquoted && value == "null")
}

func hasUnsafeURL(text string) bool {
	for _, raw := range urlPattern.FindAllString(text, maxJSONNodes) {
		if _, changed, err := sanitizeURL(raw); err != nil || changed {
			return true
		}
	}
	return false
}

func credentialPositions(text string) []int {
	var positions []int
	for _, pattern := range tokenPatterns {
		if match := pattern.FindStringIndex(text); match != nil {
			positions = append(positions, match[0])
		}
	}
	for _, match := range bearerPattern.FindAllStringSubmatchIndex(text, maxFindings) {
		value := text[match[2]:match[3]]
		if len(value) >= 24 || strings.ContainsAny(value, "0123456789_./+=-") {
			positions = append(positions, match[0])
		}
	}
	// A prose heading such as "Basic information" is not an HTTP credential.
	for _, match := range basicPattern.FindAllStringSubmatchIndex(text, maxFindings) {
		value := text[match[2]:match[3]]
		decoded, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			decoded, err = base64.RawStdEncoding.DecodeString(value)
		}
		if err == nil && bytes.ContainsRune(decoded, ':') {
			positions = append(positions, match[0])
		}
	}
	return positions
}

func lineAt(text string, offset int) int { return strings.Count(text[:offset], "\n") + 1 }

func assignmentValue(text string, match []int) (string, bool) {
	for group := 2; group <= 4; group++ {
		if start, end := match[group*2], match[group*2+1]; start >= 0 {
			return text[start:end], group == 4
		}
	}
	return "", false
}

func masked(value string) bool { return value == "" || value == Redacted }

func redactedValue(value any) bool {
	if value == nil {
		return true
	}
	if text, ok := value.(string); ok {
		return masked(text)
	}
	if object, ok := value.(map[string]any); ok {
		if content, exists := object["value"]; exists {
			return redactedValue(content)
		}
		for _, content := range object {
			if !redactedValue(content) {
				return false
			}
		}
		return true
	}
	if values, ok := value.([]any); ok {
		for _, content := range values {
			if !redactedValue(content) {
				return false
			}
		}
		return true
	}
	return false
}

func plainString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	if object, ok := value.(map[string]any); ok {
		text, _ := object["value"].(string)
		return text
	}
	return ""
}

func inspectJSON(value any, add func(string)) {
	if object, ok := value.(map[string]any); ok {
		sensitive := object["protected"] == true
		for _, name := range []string{"name", "type", "autocomplete"} {
			sensitive = sensitive || ClassifyField(plainString(object[name])) == Secret
		}
		for _, property := range asValues(object["properties"]) {
			if property, ok := property.(map[string]any); ok && property["name"] == "protected" {
				if value, ok := property["value"].(map[string]any); ok {
					sensitive = sensitive || value["value"] == true
				}
			}
		}
		for name, content := range object {
			key := normalizedField(name)
			if forbiddenFields[key] || strings.HasSuffix(key, "base64") {
				add("browser_storage_or_capture_forbidden")
			}
			if (ClassifyField(name) == Secret || sensitive && key == "value") && !redactedValue(content) {
				add("unredacted_secret_field")
			}
			inspectJSON(content, add)
		}
	} else if values, ok := value.([]any); ok {
		for _, content := range values {
			inspectJSON(content, add)
		}
	} else if text, ok := value.(string); ok {
		if dataURIPattern.MatchString(text) {
			add("inline_capture_forbidden")
		}
		if hasSecretPattern(text) {
			add("secret_pattern")
		}
		for _, raw := range urlPattern.FindAllString(html.UnescapeString(text), maxJSONNodes) {
			if _, changed, err := sanitizeURL(raw); err != nil || changed {
				add("unsafe_fixture_url")
			}
		}
	}
}

func asValues(value any) []any { values, _ := value.([]any); return values }

func inspectControls(text string, add func(string, int)) {
	tags := controlTag.FindAllStringIndex(text, maxJSONNodes)
	if len(tags) != len(controlStart.FindAllStringIndex(text, maxJSONNodes)) {
		add("ambiguous_html_control", 0)
	}
	for _, at := range tags {
		tag := text[at[0]:at[1]]
		attrs := map[string]string{}
		for _, attr := range attribute.FindAllStringSubmatch(tag, -1) {
			name := strings.ToLower(attr[1])
			value := attr[2] + attr[3] + attr[4]
			if _, duplicate := attrs[name]; duplicate {
				add("duplicate_html_attribute", lineAt(text, at[0]))
			}
			attrs[name] = value
		}
		sensitive := false
		for _, name := range []string{"name", "type", "autocomplete", "id"} {
			sensitive = sensitive || ClassifyField(attrs[name]) == Secret
		}
		if !sensitive {
			continue
		}
		if !masked(attrs["value"]) {
			add("unredacted_secret_control", lineAt(text, at[0]))
		}
		if strings.HasPrefix(strings.ToLower(tag), "<textarea") {
			remaining := text[at[1]:]
			end := strings.Index(strings.ToLower(remaining), "</textarea")
			if end < 0 || !masked(strings.TrimSpace(remaining[:end])) {
				add("unredacted_secret_control", lineAt(text, at[0]))
			}
		}
	}
}

/** Duplicate keys and trailing JSON must not hide an earlier unredacted value. */
func decodeFixture(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	remaining := maxJSONNodes
	value, err := readJSONValue(decoder, 0, &remaining)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing fixture data")
	}
	return value, nil
}

func readJSONValue(decoder *json.Decoder, depth int, remaining *int) (any, error) {
	*remaining--
	if depth > 128 || *remaining < 0 {
		return nil, fmt.Errorf("fixture JSON budget exceeded")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delimiter, ok := token.(json.Delim); ok {
		if delimiter == '{' {
			object := map[string]any{}
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				name, ok := key.(string)
				if _, exists := object[name]; !ok || exists {
					return nil, fmt.Errorf("duplicate or invalid fixture key")
				}
				value, err := readJSONValue(decoder, depth+1, remaining)
				if err != nil {
					return nil, err
				}
				object[name] = value
			}
			if closing, err := decoder.Token(); err != nil || closing != json.Delim('}') {
				return nil, fmt.Errorf("invalid fixture object")
			}
			return object, nil
		}
		if delimiter == '[' {
			values := []any{}
			for decoder.More() {
				value, err := readJSONValue(decoder, depth+1, remaining)
				if err != nil {
					return nil, err
				}
				values = append(values, value)
			}
			if closing, err := decoder.Token(); err != nil || closing != json.Delim(']') {
				return nil, fmt.Errorf("invalid fixture array")
			}
			return values, nil
		}
		return nil, fmt.Errorf("unexpected fixture delimiter")
	}
	return token, nil
}
