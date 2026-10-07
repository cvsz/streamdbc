package rtmpwire

import (
	"encoding/binary"
	"math"
	"testing"
)

func encodeString(s string) []byte {
	buf := []byte{2, byte(len(s) >> 8), byte(len(s))}
	return append(buf, s...)
}

func encodeNumber(f float64) []byte {
	buf := make([]byte, 9)
	buf[0] = 0
	binary.BigEndian.PutUint64(buf[1:], math.Float64bits(f))
	return buf
}

func TestStringsCollectsNestedValuesInOrder(t *testing.T) {
	payload := encodeString("connect")
	payload = append(payload, encodeNumber(1)...)
	payload = append(payload, 3) // object
	payload = append(payload, 0, 3)
	payload = append(payload, "app"...)
	payload = append(payload, encodeString("live")...)
	payload = append(payload, 0, 5)
	payload = append(payload, "tcUrl"...)
	payload = append(payload, encodeString("rtmp://example/live?token=abc")...)
	payload = append(payload, 0, 0, 9) // end of object

	got := Strings(payload)
	want := []string{"connect", "live", "rtmp://example/live?token=abc"}
	if len(got) != len(want) {
		t.Fatalf("strings = %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("strings = %v", got)
		}
	}
}

func TestInvokeSplitsCommandPropsAndArgs(t *testing.T) {
	payload := encodeString("play")
	payload = append(payload, encodeNumber(0)...)
	payload = append(payload, 5) // null command object
	payload = append(payload, encodeString("demo?token=abc")...)

	name, props, args, ok := Invoke(payload)
	if !ok || name != "play" {
		t.Fatalf("invoke = %q %v %v %v", name, props, args, ok)
	}
	if len(args) != 1 || args[0] != "demo?token=abc" {
		t.Fatalf("args = %v", args)
	}
}

func TestInvokeReadsConnectProperties(t *testing.T) {
	payload := encodeString("connect")
	payload = append(payload, encodeNumber(1)...)
	payload = append(payload, 3)
	payload = append(payload, 0, 3)
	payload = append(payload, "app"...)
	payload = append(payload, encodeString("live")...)
	payload = append(payload, 0, 0, 9)

	name, props, _, ok := Invoke(payload)
	if !ok || name != "connect" || props["app"] != "live" {
		t.Fatalf("invoke = %q %v %v", name, props, ok)
	}
}

func TestStringsStopsAtMalformedValue(t *testing.T) {
	payload := encodeString("publish")
	payload = append(payload, 0x0C) // unsupported type: parsing stops
	payload = append(payload, encodeString("demo")...)

	got := Strings(payload)
	if len(got) != 1 || got[0] != "publish" {
		t.Fatalf("strings = %v", got)
	}
	if _, _, _, ok := Invoke(append(payload, 0x00)); ok {
		t.Fatalf("expected invoke to reject truncated payload")
	}
}

func TestInvokeRejectsMissingCommand(t *testing.T) {
	if _, _, _, ok := Invoke(encodeNumber(1)); ok {
		t.Fatalf("expected rejection without leading command string")
	}
	if _, _, _, ok := Invoke(nil); ok {
		t.Fatalf("expected rejection of empty payload")
	}
}
