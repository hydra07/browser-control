package baseline

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOriginalTabWireContractUsesTabIDAndExactURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-test-token" {
			t.Error("missing authorization")
		}
		_, _ = w.Write([]byte(`{"success":true,"result":{"tabs":[{"tabId":17,"url":"http://fixture.test/baseline"},{"tabId":18,"url":"http://fixture.test/other"}]}}`))
	}))
	defer server.Close()
	b := &bridge{baseURL: server.URL, token: "synthetic-test-token"}
	id, err := b.tab(context.Background(), "http://fixture.test/baseline")
	if err != nil || id != 17 {
		t.Fatalf("tab = %d, error = %v", id, err)
	}
	if _, err := b.tab(context.Background(), "http://fixture.test/missing"); err == nil {
		t.Fatal("missing fixture tab must fail")
	}
}
