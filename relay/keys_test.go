package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// The fixtures are shared with packages/core/test/keys.test.ts. Both decoders
// must agree, or the same keystroke means different things locally and over SSH.
func TestDecodeInputMatchesSharedFixtures(t *testing.T) {
	raw, err := os.ReadFile("../test/fixtures/keys.json")
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var file struct {
		Cases []struct {
			In  string  `json:"in"`
			Out []Event `json:"out"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("parse fixtures: %v", err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("no fixtures found")
	}
	for _, c := range file.Cases {
		got := DecodeInput(c.In)
		if !reflect.DeepEqual(got, c.Out) {
			t.Errorf("DecodeInput(%q)\n  got  %+v\n  want %+v", c.In, got, c.Out)
		}
	}
}
