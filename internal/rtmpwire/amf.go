// Package rtmpwire provides the small, bounded RTMP wire primitives shared
// by the ingest and output servers: strict AMF0 value decoding with explicit
// state transitions. It intentionally supports only the value types that
// appear in RTMP command messages (numbers, booleans, strings, objects,
// ECMA arrays, strict arrays, null/undefined). Anything else ends parsing
// instead of being guessed at.
package rtmpwire

import (
	"encoding/binary"
	"math"
)

const (
	// MaxDecodeDepth caps recursion for nested AMF0 containers.
	MaxDecodeDepth = 16
	// MaxDecodeValues caps the number of top-level values decoded from one
	// payload so a hostile peer cannot force unbounded allocation.
	MaxDecodeValues = 256
)

// Property is one ordered member of an AMF0 object or ECMA array. Order is
// preserved because command semantics (and legacy string scans) depend on
// wire order, which a Go map would discard.
type Property struct {
	Key   string
	Value any
}

// Object is an ordered AMF0 object or ECMA array.
type Object []Property

// DecodeValues decodes a sequence of AMF0 values. It reports false as soon
// as a value is malformed, returning the values decoded so far.
func DecodeValues(data []byte) ([]any, bool) {
	values := make([]any, 0, 4)
	rest := data
	for len(rest) > 0 {
		if len(values) >= MaxDecodeValues {
			return values, false
		}
		value, consumed, ok := decodeValue(rest, 0)
		if !ok {
			return values, false
		}
		values = append(values, value)
		rest = rest[consumed:]
	}
	return values, true
}

// Strings returns every string in document order, including strings nested
// inside objects and arrays. It stops at the first malformed value and
// returns what was collected so far.
func Strings(data []byte) []string {
	values, _ := DecodeValues(data)
	var out []string
	collectStrings(values, &out)
	return out
}

func collectStrings(values []any, out *[]string) {
	for _, value := range values {
		switch typed := value.(type) {
		case string:
			*out = append(*out, typed)
		case Object:
			for _, prop := range typed {
				collectStrings([]any{prop.Value}, out)
			}
		case []any:
			collectStrings(typed, out)
		}
	}
}

// Invoke interprets an AMF command payload positionally: the leading string
// is the command name, the first object (usually the command object at index
// 2) contributes string properties, and every other top-level string is a
// positional argument in order. ok is false when the payload does not start
// with a command string or is truncated.
func Invoke(data []byte) (name string, props map[string]string, args []string, ok bool) {
	props = make(map[string]string)
	values, complete := DecodeValues(data)
	if len(values) == 0 {
		return "", props, nil, false
	}
	command, isString := values[0].(string)
	if !isString || command == "" {
		return "", props, nil, false
	}
	for _, value := range values[1:] {
		switch typed := value.(type) {
		case string:
			args = append(args, typed)
		case Object:
			for _, prop := range typed {
				if text, isString := prop.Value.(string); isString {
					if _, exists := props[prop.Key]; !exists {
						props[prop.Key] = text
					}
				}
			}
		}
	}
	return command, props, args, complete
}

// decodeValue parses one AMF0 value and returns the value plus the number of
// bytes consumed.
func decodeValue(buf []byte, depth int) (any, int, bool) {
	if depth > MaxDecodeDepth || len(buf) == 0 {
		return nil, 0, false
	}
	switch buf[0] {
	case 0: // number (float64)
		if len(buf) < 9 {
			return nil, 0, false
		}
		return math.Float64frombits(binary.BigEndian.Uint64(buf[1:9])), 9, true
	case 1: // boolean
		if len(buf) < 2 {
			return nil, 0, false
		}
		return buf[1] != 0, 2, true
	case 2: // string
		if len(buf) < 3 {
			return nil, 0, false
		}
		length := int(binary.BigEndian.Uint16(buf[1:3]))
		if len(buf) < 3+length {
			return nil, 0, false
		}
		return string(buf[3 : 3+length]), 3 + length, true
	case 3: // object
		return decodeMembers(buf, depth, false)
	case 5, 6: // null, undefined
		return nil, 1, true
	case 7: // reference
		return nil, 1, true
	case 8: // ECMA array
		return decodeMembers(buf, depth, true)
	case 10: // strict array
		if len(buf) < 5 {
			return nil, 0, false
		}
		count := int(binary.BigEndian.Uint32(buf[1:5]))
		items := make([]any, 0, min(count, MaxDecodeValues))
		offset := 5
		for i := 0; i < count; i++ {
			if offset >= len(buf) || len(items) >= MaxDecodeValues {
				return nil, 0, false
			}
			value, consumed, ok := decodeValue(buf[offset:], depth+1)
			if !ok {
				return nil, 0, false
			}
			items = append(items, value)
			offset += consumed
		}
		return items, offset, true
	default:
		return nil, 0, false
	}
}

// decodeMembers parses an AMF0 object (ecma == false) or ECMA array
// (ecma == true, which carries a uint32 member count first). Both are
// terminated by 0x00 0x00 0x09.
func decodeMembers(buf []byte, depth int, ecma bool) (any, int, bool) {
	offset := 1
	members := Object{}
	if ecma {
		if len(buf) < 5 {
			return nil, 0, false
		}
		count := int(binary.BigEndian.Uint32(buf[1:5]))
		offset = 5
		for i := 0; i < count; i++ {
			key, value, next, ok := decodeMember(buf, offset, depth)
			if !ok {
				return nil, 0, false
			}
			members = append(members, Property{Key: key, Value: value})
			offset = next
		}
	}
	for {
		if offset+2 > len(buf) {
			return nil, 0, false
		}
		keyLen := int(binary.BigEndian.Uint16(buf[offset : offset+2]))
		offset += 2
		if keyLen == 0 {
			if offset >= len(buf) || buf[offset] != 9 {
				return nil, 0, false
			}
			return members, offset + 1, true
		}
		if offset+keyLen > len(buf) {
			return nil, 0, false
		}
		key := string(buf[offset : offset+keyLen])
		offset += keyLen
		if offset >= len(buf) {
			return nil, 0, false
		}
		value, consumed, ok := decodeValue(buf[offset:], depth+1)
		if !ok {
			return nil, 0, false
		}
		members = append(members, Property{Key: key, Value: value})
		offset += consumed
	}
}

// decodeMember parses one key/value member of an ECMA array at offset.
func decodeMember(buf []byte, offset, depth int) (string, any, int, bool) {
	if offset+2 > len(buf) {
		return "", nil, 0, false
	}
	keyLen := int(binary.BigEndian.Uint16(buf[offset : offset+2]))
	offset += 2
	if offset+keyLen > len(buf) {
		return "", nil, 0, false
	}
	key := string(buf[offset : offset+keyLen])
	offset += keyLen
	if offset >= len(buf) {
		return "", nil, 0, false
	}
	value, consumed, ok := decodeValue(buf[offset:], depth+1)
	if !ok {
		return "", nil, 0, false
	}
	return key, value, offset + consumed, true
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
