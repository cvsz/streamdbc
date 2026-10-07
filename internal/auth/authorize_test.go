package auth

import "testing"

func TestSplitStreamToken(t *testing.T) {
	id, token := SplitStreamToken("demo?token=abc123")
	if id != "demo" || token != "abc123" {
		t.Fatalf("id=%q token=%q", id, token)
	}
	id, token = SplitStreamToken("demo")
	if id != "demo" || token != "" {
		t.Fatalf("id=%q token=%q", id, token)
	}
}

func TestTokenFromHeader(t *testing.T) {
	if got := TokenFromHeader("Bearer xyz"); got != "xyz" {
		t.Fatalf("token = %q", got)
	}
	if got := TokenFromHeader("Basic abc"); got != "" {
		t.Fatalf("token = %q", got)
	}
}

func TestAuthorizeNilManagerAllows(t *testing.T) {
	if !Authorize(nil, "", "publish", "demo", "1.2.3.4") {
		t.Fatal("nil manager should allow")
	}
}
