package rtmp

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"time"
)

const (
	rtmpVersion       = 3
	rtmpHandshakeSize = 1536
	defaultChunkSize  = 128
	maxMessageSize    = 8 << 20
	// maxAuthCommands bounds how many control messages one connection may
	// send before completing play authentication.
	maxAuthCommands = 64
)

// doHandshake performs the server side of the plain RTMP handshake: it reads
// C0+C1, answers S0+S1+S2, and verifies that C2 echoes S1. Callers must set
// read/write deadlines; every read and write here is bounded.
func doHandshake(conn net.Conn, reader *bufio.Reader, writer *bufio.Writer) error {
	var version [1]byte
	if _, err := io.ReadFull(reader, version[:]); err != nil {
		return fmt.Errorf("read RTMP version: %w", err)
	}
	if version[0] != rtmpVersion {
		return fmt.Errorf("unsupported RTMP version %d", version[0])
	}
	c1 := make([]byte, rtmpHandshakeSize)
	if _, err := io.ReadFull(reader, c1); err != nil {
		return fmt.Errorf("read RTMP C1: %w", err)
	}
	s1 := make([]byte, rtmpHandshakeSize)
	binary.BigEndian.PutUint32(s1[:4], rtmpTimestamp())
	if _, err := rand.Read(s1[8:]); err != nil {
		return fmt.Errorf("generate RTMP handshake challenge: %w", err)
	}
	if err := writer.WriteByte(rtmpVersion); err != nil {
		return fmt.Errorf("write RTMP S0: %w", err)
	}
	if _, err := writer.Write(s1); err != nil {
		return fmt.Errorf("write RTMP S1: %w", err)
	}
	if _, err := writer.Write(c1); err != nil {
		return fmt.Errorf("write RTMP S2: %w", err)
	}
	if err := writer.Flush(); err != nil {
		return fmt.Errorf("flush RTMP handshake: %w", err)
	}
	c2 := make([]byte, rtmpHandshakeSize)
	if _, err := io.ReadFull(reader, c2); err != nil {
		return fmt.Errorf("read RTMP C2: %w", err)
	}
	if !bytes.Equal(c2, s1) {
		return fmt.Errorf("RTMP C2 does not echo S1")
	}
	return nil
}

func rtmpTimestamp() uint32 {
	seconds := time.Now().Unix()
	if seconds < 0 {
		return 0
	}
	const modulus = int64(1 << 32)
	seconds %= modulus
	// #nosec G115 -- the explicit modulo above bounds the RTMP uint32 timestamp.
	return uint32(seconds)
}

// commandReader assembles RTMP chunk-stream messages for the control plane.
// It understands full (format 0) headers and format-3 continuations plus
// SetChunkSize so framing stays synchronized with real clients.
type commandReader struct {
	reader    *bufio.Reader
	chunkSize uint32
}

func newCommandReader(reader *bufio.Reader) *commandReader {
	return &commandReader{reader: reader, chunkSize: defaultChunkSize}
}

// readMessage returns the next assembled message payload with its message
// type. SetChunkSize messages are consumed internally.
func (r *commandReader) readMessage() (byte, []byte, error) {
	for {
		messageType, payload, err := r.readRawMessage()
		if err != nil {
			return 0, nil, err
		}
		if messageType == 1 {
			if len(payload) != 4 {
				return 0, nil, fmt.Errorf("invalid RTMP chunk-size message")
			}
			size := binary.BigEndian.Uint32(payload)
			if size == 0 || size > maxMessageSize {
				return 0, nil, fmt.Errorf("invalid RTMP chunk size %d", size)
			}
			r.chunkSize = size
			continue
		}
		return messageType, payload, nil
	}
}

func (r *commandReader) readRawMessage() (byte, []byte, error) {
	basic, err := r.reader.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	format := basic >> 6
	chunkStreamID := uint32(basic & 0x3f)
	switch chunkStreamID {
	case 0:
		value, err := r.reader.ReadByte()
		if err != nil {
			return 0, nil, err
		}
		chunkStreamID = uint32(value) + 64
	case 1:
		var extended [2]byte
		if _, err := io.ReadFull(r.reader, extended[:]); err != nil {
			return 0, nil, err
		}
		chunkStreamID = uint32(extended[0]) + uint32(extended[1])*256 + 64
	}
	if format != 0 {
		return 0, nil, fmt.Errorf("unsupported RTMP chunk header format %d", format)
	}
	var header [11]byte
	if _, err := io.ReadFull(r.reader, header[:]); err != nil {
		return 0, nil, err
	}
	length := uint32(header[3])<<16 | uint32(header[4])<<8 | uint32(header[5])
	if length > maxMessageSize {
		return 0, nil, fmt.Errorf("RTMP message exceeds configured limit")
	}
	messageType := header[6]
	extendedTimestamp := header[0] == 0xff && header[1] == 0xff && header[2] == 0xff
	if extendedTimestamp {
		var extended [4]byte
		if _, err := io.ReadFull(r.reader, extended[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, length)
	remaining := length
	chunkSize := r.chunkSize
	if chunkSize == 0 {
		chunkSize = defaultChunkSize
	}
	for remaining > 0 {
		part := remaining
		if part > chunkSize {
			part = chunkSize
		}
		start := length - remaining
		if _, err := io.ReadFull(r.reader, payload[start:start+part]); err != nil {
			return 0, nil, err
		}
		remaining -= part
		if remaining == 0 {
			break
		}
		continuation, err := r.reader.ReadByte()
		if err != nil {
			return 0, nil, err
		}
		if continuation>>6 != 3 {
			return 0, nil, fmt.Errorf("invalid RTMP continuation chunk")
		}
		continuationID := uint32(continuation & 0x3f)
		switch continuationID {
		case 0:
			var extended [1]byte
			if _, err := io.ReadFull(r.reader, extended[:]); err != nil {
				return 0, nil, err
			}
			continuationID = uint32(extended[0]) + 64
		case 1:
			var extended [2]byte
			if _, err := io.ReadFull(r.reader, extended[:]); err != nil {
				return 0, nil, err
			}
			continuationID = uint32(extended[0]) + uint32(extended[1])*256 + 64
		}
		if continuationID != chunkStreamID {
			return 0, nil, fmt.Errorf("invalid RTMP continuation chunk")
		}
		if extendedTimestamp {
			var extended [4]byte
			if _, err := io.ReadFull(r.reader, extended[:]); err != nil {
				return 0, nil, err
			}
		}
	}
	return messageType, payload, nil
}
