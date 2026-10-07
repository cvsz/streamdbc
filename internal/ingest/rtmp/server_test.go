package rtmp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"testing"

	"github.com/cvsz/stremdbc/internal/config"
	"go.uber.org/zap"
)

func TestRTMPHandshakeFollowsWireFormat(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()
	handler := newConnectionHandler(serverConn, nil, nil, zap.NewNop())
	c1 := bytes.Repeat([]byte{0x11}, 1536)
	done := make(chan error, 1)
	go func() { done <- handler.handshake() }()

	if _, err := clientConn.Write(append([]byte{3}, c1...)); err != nil {
		t.Fatalf("write client handshake: %v", err)
	}
	serverHandshake := make([]byte, 3073)
	if _, err := io.ReadFull(clientConn, serverHandshake); err != nil {
		t.Fatalf("read server handshake: %v", err)
	}
	if serverHandshake[0] != 3 || !bytes.Equal(serverHandshake[1537:], c1) {
		t.Fatal("server handshake did not echo C1 as S2")
	}
	if _, err := clientConn.Write(serverHandshake[1:1537]); err != nil {
		t.Fatalf("write C2: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("handshake: %v", err)
	}
}

func TestRTMPMessageParserReadsChunkedFormatZeroMessage(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()
	handler := newConnectionHandler(serverConn, nil, nil, zap.NewNop())
	handler.chunkSize = 4
	payload := []byte("abcdefghij")
	message := make([]byte, 0, len(payload)+14)
	message = append(message, 0x03, 0, 0, 1, byte(len(payload)>>16), byte(len(payload)>>8), byte(len(payload)), 20, 1, 0, 0, 0)
	message = append(message, payload[:4]...)
	message = append(message, 0xc3)
	message = append(message, payload[4:8]...)
	message = append(message, 0xc3)
	message = append(message, payload[8:]...)
	go func() { _, _ = clientConn.Write(message) }()

	got, err := handler.readMessage()
	if err != nil {
		t.Fatalf("read message: %v", err)
	}
	if got.MessageType != 20 || got.StreamID != 1 || !bytes.Equal(got.Payload, payload) {
		t.Fatalf("message = %+v", got)
	}
}

func TestRTMPStreamKeyNeverDefaultsAndValidates(t *testing.T) {
	handler := newConnectionHandler(nil, nil, nil, zap.NewNop())
	if _, err := handler.extractStreamKey([]byte("publish")); !errors.Is(err, ErrStreamKeyMissing) {
		t.Fatalf("missing key error = %v", err)
	}
	command := append([]byte{2, 0, 7}, []byte("publish")...)
	command = append(command, 2, 0, 4, 'd', 'e', 'm', 'o')
	key, err := handler.extractStreamKey(command)
	if err != nil || key != "demo" {
		t.Fatalf("stream key = %q, error = %v", key, err)
	}
}

func TestRTMPStartFailureDoesNotLeaveServerRunning(t *testing.T) {
	server := NewServer(&config.RTMPConfig{Host: "127.0.0.1", Port: -1}, nil, zap.NewNop())
	if err := server.Start(context.Background()); err == nil {
		t.Fatal("invalid RTMP address unexpectedly started")
	}
	if server.running {
		t.Fatal("failed RTMP start left running state set")
	}
}

func TestRTMPConnectionHandlerHonorsContext(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()
	handler := newConnectionHandler(serverConn, nil, nil, zap.NewNop())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := handler.run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled handler error = %v", err)
	}
}

func TestRTMPParserHandlesExtendedChunkStreamIDs(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()
	handler := newConnectionHandler(serverConn, nil, nil, zap.NewNop())
	handler.chunkSize = 4
	payload := []byte("abcdefghij")
	message := make([]byte, 0, len(payload)+16)
	message = append(message, 0x00, 0x00) // fmt 0, csID bits 0 => extended csID 64
	message = append(message, 0, 0, 1, byte(0), byte(0), byte(len(payload)), 20, 1, 0, 0, 0)
	message = append(message, payload[:4]...)
	message = append(message, 0xC0, 0x00) // fmt 3 continuation, extended csID 64
	message = append(message, payload[4:8]...)
	message = append(message, 0xC0, 0x00)
	message = append(message, payload[8:]...)
	go func() { _, _ = clientConn.Write(message) }()

	got, err := handler.readMessage()
	if err != nil {
		t.Fatalf("read message: %v", err)
	}
	if got.MessageType != 20 || got.StreamID != 1 || !bytes.Equal(got.Payload, payload) {
		t.Fatalf("message = %+v", got)
	}
}

func TestRTMPParserHandlesExtendedTimestampContinuations(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()
	handler := newConnectionHandler(serverConn, nil, nil, zap.NewNop())
	handler.chunkSize = 4
	payload := []byte("abcdefghij")
	message := make([]byte, 0, len(payload)+20)
	message = append(message, 0x03)                                     // fmt 0, csID 3
	message = append(message, 0xFF, 0xFF, 0xFF)                         // extended timestamp marker
	message = append(message, 0, 0, byte(len(payload)), 20, 1, 0, 0, 0) // length=10, type 20, stream 1
	message = append(message, 0, 0, 3, 232)                             // extended timestamp 1000
	message = append(message, payload[:4]...)
	message = append(message, 0xC3)         // fmt 3 continuation
	message = append(message, 0, 0, 3, 232) // extended timestamp repeats
	message = append(message, payload[4:8]...)
	message = append(message, 0xC3)
	message = append(message, 0, 0, 3, 232)
	message = append(message, payload[8:]...)
	go func() { _, _ = clientConn.Write(message) }()

	got, err := handler.readMessage()
	if err != nil {
		t.Fatalf("read message: %v", err)
	}
	if got.Timestamp != 1000 || got.MessageType != 20 || !bytes.Equal(got.Payload, payload) {
		t.Fatalf("message = %+v", got)
	}
}

func TestRTMPUnparseableCommandRegistersNothing(t *testing.T) {
	handler := newConnectionHandler(nil, nil, nil, zap.NewNop())
	// AMF3 invoke bodies and truncated payloads must not yield a stream key
	// and must never panic the connection handler.
	for _, payload := range [][]byte{
		{0x11, 0x02, 0x07, 'p', 'u', 'b', 'l', 'i', 's', 'h'}, // AMF3 marker, not AMF0
		{2, 0, 7, 'p', 'u', 'b'},                              // truncated string
		{2, 0, 7, 'p', 'u', 'b', 'l', 'i', 's', 'h'},          // command without key
		nil,
	} {
		if _, err := handler.extractStreamKey(payload); !errors.Is(err, ErrStreamKeyMissing) {
			t.Fatalf("payload %v: expected missing key, got %v", payload, err)
		}
	}
	// A lone well-formed "publish" string identifies the command, but key
	// extraction still fails closed because no stream key follows it.
	if got := firstAMFString([]byte{2, 0, 7, 'p', 'u', 'b', 'l', 'i', 's', 'h'}); got != "publish" {
		t.Fatalf("command = %q", got)
	}
	for _, payload := range [][]byte{
		{0x11, 0x02, 0x07, 'p', 'u', 'b', 'l', 'i', 's', 'h'},
		{2, 0, 7, 'p', 'u', 'b'},
		nil,
	} {
		if got := firstAMFString(payload); got == "publish" {
			t.Fatalf("payload %v: unparseable command misidentified", payload)
		}
	}
}
