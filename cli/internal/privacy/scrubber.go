package privacy

import (
	"net/url"
	"slices"
	"strings"
)

type Scrubber struct{ values *strings.Replacer }

func URLCredentials(raw string) []string {
	u, err := url.Parse(raw)
	if err != nil {
		return nil
	}
	var values []string
	if u.User != nil {
		password, _ := u.User.Password()
		values = append(values, u.User.Username(), password)
	}
	for _, query := range []url.Values{u.Query(), fragmentQuery(u.Fragment)} {
		for key, found := range query {
			base, _, _ := strings.Cut(key, "[")
			if ClassifyField(base) == Secret {
				values = append(values, found...)
			}
		}
	}
	if u.Fragment != "" {
		values = append(values, u.Fragment)
	}
	return values
}

func fragmentQuery(fragment string) url.Values {
	if _, query, found := strings.Cut(fragment, "?"); found {
		fragment = query
	}
	values, _ := url.ParseQuery(fragment)
	return values
}

func NewScrubber(values []string) *Scrubber {
	values = slices.Clone(values)
	slices.SortFunc(values, func(a, b string) int {
		if len(a) != len(b) {
			return len(b) - len(a)
		}
		return strings.Compare(a, b)
	})
	values = slices.Compact(values)
	var pairs []string
	for _, value := range values {
		if !masked(value) {
			pairs = append(pairs, value, Redacted)
		}
	}
	return &Scrubber{values: strings.NewReplacer(pairs...)}
}

func (s *Scrubber) text(value string) string {
	value = s.values.Replace(value)
	for _, pattern := range tokenPatterns {
		value = pattern.ReplaceAllString(value, Redacted)
	}
	value = bearerPattern.ReplaceAllStringFunc(value, func(match string) string {
		if len(credentialPositions(match)) > 0 {
			return Redacted
		}
		return match
	})
	value = basicPattern.ReplaceAllStringFunc(value, func(match string) string {
		if len(credentialPositions(match)) > 0 {
			return Redacted
		}
		return match
	})
	return secretAssignment.ReplaceAllStringFunc(value, func(match string) string {
		if hasSecretPattern(match) {
			return Redacted
		}
		return match
	})
}

func (s *Scrubber) Text(value string) string {
	value = urlPattern.ReplaceAllStringFunc(value, func(raw string) string {
		trimmed := strings.TrimRight(raw, ".,;)")
		return s.URL(trimmed) + raw[len(trimmed):]
	})
	return s.text(value)
}

func (s *Scrubber) URL(value string) string {
	clean, err := SanitizeURL(value)
	if err != nil {
		return Redacted
	}
	u, err := url.Parse(clean)
	if err != nil {
		return Redacted
	}
	if s.text(u.Host) != u.Host {
		return Redacted
	}
	u.Path, u.RawPath = s.text(u.Path), ""
	query := u.Query()
	for name, values := range query {
		for i, value := range values {
			values[i] = s.text(value)
		}
		query[name] = values
	}
	u.RawQuery = query.Encode()
	return u.String()
}
