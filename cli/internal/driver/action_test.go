package driver

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedActionResultWireFixtures(t *testing.T) {
	data, err := os.ReadFile("../../../packages/shared/testdata/action-results.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Valid  bool
		Result ActionResult
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for i, fixture := range fixtures {
		if valid := fixture.Result.Validate() == nil; valid != fixture.Valid {
			t.Errorf("fixture %d: valid=%t expected=%t", i, valid, fixture.Valid)
		}
	}
}
