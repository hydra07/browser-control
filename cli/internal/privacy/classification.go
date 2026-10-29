package privacy

import (
	"errors"
	"net/url"
	"strings"
)

type Class string

const (
	Ordinary Class = "ordinary"
	Business Class = "business"
	Secret   Class = "secret"
	Redacted       = "[REDACTED]"
)

var secretFields = fieldSet("password passwd pwd passphrase currentpassword newpassword secret clientsecret token accesstoken refreshtoken idtoken authtoken oauthtoken apikey accesskeyid secretaccesskey awsaccesskeyid awssecretaccesskey awssessiontoken authorization proxyauthorization session sessionid sessiontoken cookie setcookie otp totp onetimepassword onetimecode verificationcode cardnumber cardno cardnum creditcardnumber ccnumber ccnum pan cvv cvc cccsc securitycode pin")
var businessFields = fieldSet("email name firstname lastname fullname address postalcode orderid ordernumber")

func fieldSet(names string) map[string]bool {
	fields := make(map[string]bool)
	for _, name := range strings.Fields(names) {
		fields[name] = true
	}
	return fields
}

func normalizedField(name string) string {
	var out strings.Builder
	for _, char := range strings.ToLower(name) {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' {
			out.WriteRune(char)
		}
	}
	return out.String()
}

func ClassifyField(name string) Class {
	key := normalizedField(name)
	if secretFields[key] {
		return Secret
	}
	if businessFields[key] {
		return Business
	}
	return Ordinary
}

func SanitizeURL(raw string) (string, error) {
	clean, _, err := sanitizeURL(raw)
	return clean, err
}

func sanitizeURL(raw string) (string, bool, error) {
	if raw == "about:blank" {
		return raw, false, nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.Opaque != "" {
		return "", false, errors.New("fixture URL must be HTTP(S), without malformed encoding, or about:blank")
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return "", false, errors.New("fixture URL has malformed query encoding")
	}
	changed := u.User != nil || u.Fragment != ""
	u.User, u.Fragment, u.RawFragment = nil, "", ""
	for name := range query {
		base, _, _ := strings.Cut(name, "[")
		if ClassifyField(base) == Secret {
			query.Del(name)
			changed = true
		}
	}
	u.RawQuery = query.Encode()
	return u.String(), changed, nil
}
