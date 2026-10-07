package rtmp

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"net"
	"testing"
	"time"

	"github.com/cvsz/stremdbc/internal/auth"
	"github.com/cvsz/stremdbc/internal/config"
	"go.uber.org/zap"
)

const (
	testJWTSecret = "0123456789abcdef0123456789abcdef"
	testAPIKey    = "test-api-key-0123456789"
)

func testAuthManager(t *testing.T) *auth.Manager {
	t.Helper()
	manager, err := auth.NewManager(testJWTSecret, "15m", []string{testAPIKey}, false)
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

// rtmpTestClient performs the client side of the RTMP handshake and sends
// AMF0 command messages with the default chunk size.
type rtmpTestClient struct {
	conn   net.Conn
	reader *bufio.Reader
}

func dialRTMPTestClient(t *testing.T, addr string) *rtmpTestClient {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	client := &rtmpTestClient{conn: conn, reader: bufio.NewReader(conn)}
	if _, err := conn.Write([]byte{rtmpVersion}); err != nil {
		t.Fatal(err)
	}
	c1 := make([]byte, rtmpHandshakeSize)
	if _, err := rand.Read(c1); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write(c1); err != nil {
		t.Fatal(err)
	}
	s0 := make([]byte, 1+2*rtmpHandshakeSize)
	if _, err := io.ReadFull(client.reader, s0); err != nil {
		t.Fatal(err)
	}
	if s0[0] != rtmpVersion {
		t.Fatalf("server version = %d", s0[0])
	}
	if _, err := conn.Write(s0[1 : 1+rtmpHandshakeSize]); err != nil {
		t.Fatal(err)
	}
	return client
}

func amfTestString(s string) []byte {
	buf := []byte{2, byte(len(s) >> 8), byte(len(s))}
	return append(buf, s...)
}

func amfTestNumber(f float64) []byte {
	buf := make([]byte, 9)
	binary.BigEndian.PutUint64(buf[1:], math.Float64bits(f))
	return buf
}

func (c *rtmpTestClient) sendCommand(t *testing.T, payload []byte) {
	t.Helper()
	header := []byte{0x03, 0, 0, 0, byte(len(payload) >> 16), byte(len(payload) >> 8), byte(len(payload)), 20, 0, 0, 0, 0}
	if _, err := c.conn.Write(header); err != nil {
		t.Fatal(err)
	}
	for len(payload) > 0 {
		part := len(payload)
		if part > defaultChunkSize {
			part = defaultChunkSize
		}
		if _, err := c.conn.Write(payload[:part]); err != nil {
			t.Fatal(err)
		}
		payload = payload[part:]
		if len(payload) > 0 {
			if _, err := c.conn.Write([]byte{0xC3}); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func connectPayload(tcURL string) []byte {
	payload := amfTestString("connect")
	payload = append(payload, amfTestNumber(1)...)
	payload = append(payload, 3, 0, 3)
	payload = append(payload, "app"...)
	payload = append(payload, amfTestString("live")...)
	payload = append(payload, 0, 5)
	payload = append(payload, "tcUrl"...)
	payload = append(payload, amfTestString(tcURL)...)
	payload = append(payload, 0, 0, 9)
	return payload
}

func playPayload(streamKey string) []byte {
	payload := amfTestString("play")
	payload = append(payload, amfTestNumber(0)...)
	payload = append(payload, 5)
	return append(payload, amfTestString(streamKey)...)
}

func startAuthedOutputServer(t *testing.T, manager *auth.Manager) (string, *Server) {
	t.Helper()
	server := NewServer(&config.RTMPOutputConfig{Host: "127.0.0.1", Port: 0, ReadTimeout: 5 * time.Second}, nil, zap.NewNop())
	server.SetAuthManager(manager)
	if err := server.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Stop(context.Background()) })
	addr := server.listener.Addr().String()
	return addr, server
}

func findSessionByAddr(t *testing.T, server *Server, addr string) *Session {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, session := range server.GetSessions() {
			// Sessions are registered in "connected" state before the
			// handshake completes; wait for the authorized state.
			if session.RemoteAddr == addr && session.State == sessionPlaying {
				return session
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	sessions := server.GetSessions()
	t.Fatalf("playing session for %s not found (have %+v)", addr, sessions)
	return nil
}

func TestRTMPOutputPlayRequiresValidToken(t *testing.T) {
	manager := testAuthManager(t)
	token, err := manager.GeneratePlayToken("demo", "")
	if err != nil {
		t.Fatal(err)
	}
	addr, server := startAuthedOutputServer(t, manager)
	client := dialRTMPTestClient(t, addr)
	client.sendCommand(t, connectPayload("rtmp://127.0.0.1/live"))
	client.sendCommand(t, playPayload("demo?token="+token))

	session := findSessionByAddr(t, server, client.conn.LocalAddr().String())
	if session.State != sessionPlaying || session.StreamID != "demo" {
		t.Fatalf("session = %+v", session)
	}
}

func TestRTMPOutputConnectTokenAuthorizesPlay(t *testing.T) {
	manager := testAuthManager(t)
	token, err := manager.GeneratePlayToken("demo", "")
	if err != nil {
		t.Fatal(err)
	}
	addr, server := startAuthedOutputServer(t, manager)
	client := dialRTMPTestClient(t, addr)
	client.sendCommand(t, connectPayload("rtmp://127.0.0.1/live?token="+token))
	client.sendCommand(t, playPayload("demo"))

	session := findSessionByAddr(t, server, client.conn.LocalAddr().String())
	if session.State != sessionPlaying || session.StreamID != "demo" {
		t.Fatalf("session = %+v", session)
	}
}

func TestRTMPOutputRejectsInvalidPlayToken(t *testing.T) {
	manager := testAuthManager(t)
	addr, _ := startAuthedOutputServer(t, manager)
	client := dialRTMPTestClient(t, addr)
	client.sendCommand(t, connectPayload("rtmp://127.0.0.1/live"))
	client.sendCommand(t, playPayload("demo?token=invalid"))

	_ = client.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 1)
	if _, err := client.reader.Read(buf); err == nil {
		t.Fatal("expected connection close after rejected play token")
	}
}

func TestRTMPOutputRejectsTokenForOtherStream(t *testing.T) {
	manager := testAuthManager(t)
	token, err := manager.GeneratePlayToken("other", "")
	if err != nil {
		t.Fatal(err)
	}
	addr, _ := startAuthedOutputServer(t, manager)
	client := dialRTMPTestClient(t, addr)
	client.sendCommand(t, connectPayload("rtmp://127.0.0.1/live"))
	client.sendCommand(t, playPayload("demo?token="+token))

	_ = client.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 1)
	if _, err := client.reader.Read(buf); err == nil {
		t.Fatal("expected connection close after cross-stream token")
	}
}

func TestRTMPOutputLegacyModeWithoutAuthManager(t *testing.T) {
	addr, server := startAuthedOutputServer(t, nil)
	client := dialRTMPTestClient(t, addr)
	client.sendCommand(t, connectPayload("rtmp://127.0.0.1/live"))
	client.sendCommand(t, playPayload("demo"))

	session := findSessionByAddr(t, server, client.conn.LocalAddr().String())
	if session.State != sessionPlaying {
		t.Fatalf("session = %+v", session)
	}
}

func TestRTMPOutputGetSessionsIsOrderedSnapshot(t *testing.T) {
	server := NewServer(nil, nil, zap.NewNop())
	server.sessions["b"] = &Session{ID: "b", State: sessionConnected}
	server.sessions["a"] = &Session{ID: "a", State: sessionConnected}
	sessions := server.GetSessions()
	if len(sessions) != 2 || sessions[0].ID != "a" || sessions[1].ID != "b" {
		t.Fatalf("sessions = %+v", sessions)
	}
	if fmt.Sprint(sessions[0].Conn) != "<nil>" {
		t.Fatal("session snapshot exposed connection")
	}
}
