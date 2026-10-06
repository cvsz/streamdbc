package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/cvsz/stremdbc/internal/auth"
	"github.com/cvsz/stremdbc/internal/config"
	"github.com/cvsz/stremdbc/internal/core"
	"github.com/cvsz/stremdbc/internal/gateway/samsung"
	"github.com/cvsz/stremdbc/internal/metrics"
	"go.uber.org/zap"
)

// Server represents the REST and management HTTP server.
type Server struct {
	config         *config.APIConfig
	registry       *core.StreamRegistry
	metrics        *metrics.Metrics
	logger         *zap.Logger
	mux            *http.ServeMux
	authManager    *auth.Manager
	httpServer     *http.Server
	listener       net.Listener
	startMu        sync.Mutex
	lifecycleMu    sync.Mutex
	basePath       string
	version        string
	versionMu      sync.RWMutex
	authMu         sync.RWMutex
	startedAt      time.Time
	readTimeout    time.Duration
	writeTimeout   time.Duration
	idleTimeout    time.Duration
	metricsEnabled bool
	metricsPath    string
	routeMu        sync.Mutex
	routes         map[string]struct{}
	metricsMu      sync.RWMutex
	componentStats map[string]func() map[string]interface{}
	statsMu        sync.RWMutex
	trustedProxies []*net.IPNet
	rateLimit      int
	rateMu         sync.Mutex
	rateEntries    map[string]*rateEntry
	samsungTV      *samsung.Manager
}

type rateEntry struct {
	windowStart time.Time
	count       int
}

func NewServer(cfg *config.APIConfig, registry *core.StreamRegistry, m *metrics.Metrics, logger *zap.Logger) *Server {
	if cfg == nil {
		cfg = &config.APIConfig{Enable: true, BasePath: "/api/v1", CORSOrigins: []string{"*"}}
	}
	copyCfg := *cfg
	copyCfg.CORSOrigins = append([]string(nil), cfg.CORSOrigins...)
	cfg = &copyCfg
	if registry == nil {
		registry = core.NewStreamRegistry(config.DefaultConfig())
	}
	if m == nil {
		m = metrics.NewMetrics()
	}
	if logger == nil {
		logger = zap.NewNop()
	}
	basePath := strings.TrimRight(cfg.BasePath, "/")
	if basePath == "" {
		basePath = "/api/v1"
	}
	if !validRoutePath(basePath) {
		basePath = "/api/v1"
	}

	s := &Server{
		config:         cfg,
		registry:       registry,
		metrics:        m,
		logger:         logger.Named("api"),
		mux:            http.NewServeMux(),
		basePath:       basePath,
		version:        "dev",
		startedAt:      time.Now(),
		readTimeout:    30 * time.Second,
		writeTimeout:   30 * time.Second,
		idleTimeout:    120 * time.Second,
		metricsEnabled: true,
		metricsPath:    "/metrics",
		routes:         make(map[string]struct{}),
		componentStats: make(map[string]func() map[string]interface{}),
		trustedProxies: parseTrustedProxies(cfg.TrustedProxies),
		rateLimit:      cfg.RateLimitPerMinute,
		rateEntries:    make(map[string]*rateEntry),
	}
	s.registerRoutes()
	return s
}

func (s *Server) SetAuthManager(am *auth.Manager) {
	s.authMu.Lock()
	defer s.authMu.Unlock()
	s.authManager = am
}

// SetHTTPTimeouts configures the HTTP server timeouts used when Start is called.
func (s *Server) SetHTTPTimeouts(readTimeout, writeTimeout, idleTimeout time.Duration) {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	if readTimeout > 0 {
		s.readTimeout = readTimeout
	}
	if writeTimeout > 0 {
		s.writeTimeout = writeTimeout
	}
	if idleTimeout > 0 {
		s.idleTimeout = idleTimeout
	}
}

// SetMetricsConfig enables the metrics endpoint at the configured path.
func (s *Server) SetMetricsConfig(enabled bool, path string) {
	if path == "" {
		path = "/metrics"
	}
	if !validRoutePath(path) || path == "/health" || path == "/health/live" || path == "/health/ready" || path == "/ready" || path == s.basePath+"/info" || path == s.basePath+"/stats" || path == s.basePath+"/auth/token" || path == s.basePath+"/streams" || strings.HasPrefix(path, s.basePath+"/streams/") || conflictsWithStaticPath(path) {
		return
	}
	if path != "/metrics" {
		if !s.registerRoute(path, http.HandlerFunc(s.handleMetrics)) {
			return
		}
	}
	s.metricsMu.Lock()
	s.metricsEnabled = enabled
	s.metricsPath = path
	s.metricsMu.Unlock()
}

func (s *Server) SetVersion(version string) {
	if strings.TrimSpace(version) != "" {
		s.versionMu.Lock()
		s.version = version
		s.versionMu.Unlock()
	}
}

func (s *Server) authManagerSnapshot() *auth.Manager {
	s.authMu.RLock()
	defer s.authMu.RUnlock()
	return s.authManager
}

func (s *Server) versionSnapshot() string {
	s.versionMu.RLock()
	defer s.versionMu.RUnlock()
	return s.version
}

// RegisterStats adds a component statistics provider to /api/v1/stats.
func (s *Server) RegisterStats(name string, provider func() map[string]interface{}) {
	if name == "" || provider == nil {
		return
	}
	s.statsMu.Lock()
	s.componentStats[name] = provider
	s.statsMu.Unlock()
}

// SetStaticRoutes exposes streaming assets and the zero-build management UI.
func (s *Server) SetStaticRoutes(hlsPath, llhlsPath, playerFile, dashboardDir string) {
	if hlsPath != "" {
		s.registerRoute("/hls/", s.staticHandler("/hls/", hlsPath, true))
	}
	if llhlsPath != "" {
		s.registerRoute("/llhls/", s.staticHandler("/llhls/", llhlsPath, true))
	}
	if playerFile != "" {
		s.registerRoute("/player/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				s.methodNotAllowed(w)
				return
			}
			streamID, err := url.PathUnescape(strings.TrimPrefix(r.URL.EscapedPath(), "/player/"))
			if err != nil || core.ValidateStreamID(streamID) != nil {
				http.NotFound(w, r)
				return
			}
			if !s.authorizePlayback(w, r, streamID) {
				return
			}
			serveStaticFile(w, r, playerFile)
		}))
	}
	if dashboardDir != "" {
		s.registerRoute("/dashboard", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				s.methodNotAllowed(w)
				return
			}
			http.Redirect(w, r, "/dashboard/", http.StatusTemporaryRedirect)
		}))
		s.registerRoute("/dashboard/", s.staticHandler("/dashboard/", dashboardDir, false))
	}
}

// SetSamsungTV registers the F5500-specific pages, HLS output, and status and
// management endpoints. The HLS route serves only known generated filenames.
func (s *Server) SetSamsungTV(manager *samsung.Manager, cfg config.SamsungTVConfig, tvDirectory string) {
	s.samsungTV = manager
	page := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				s.methodNotAllowed(w)
				return
			}
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			serveStaticFile(w, r, filepath.Join(tvDirectory, name))
		}
	}
	if tvDirectory != "" {
		s.registerRoute("/tv", page("index.html"))
		s.registerRoute("/tv/", page("index.html"))
		s.registerRoute("/tv/basic", page("basic.html"))
	}
	if cfg.Enable && cfg.OutputPath != "" {
		s.registerRoute("/tv/live/", samsungHLShandler(cfg.OutputPath, s))
	}
	s.registerRoute(s.basePath+"/tv/status", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			s.methodNotAllowed(w)
			return
		}
		status := samsung.Status{Enabled: cfg.Enable, State: samsung.StateStopped, Profile: cfg.Profile}
		if s.samsungTV != nil {
			status = s.samsungTV.Status()
		}
		s.writeJSON(w, http.StatusOK, map[string]interface{}{
			"enabled":        status.Enabled,
			"state":          strings.ToLower(status.State),
			"profile":        status.Profile,
			"restart_count":  status.RestartCount,
			"last_error":     status.LastError,
			"started_at":     status.StartedAt,
			"last_exit":      status.LastExit,
			"playlist_ready": status.PlaylistReady,
		})
	}))
	for _, operation := range []string{"start", "stop", "restart"} {
		action := operation
		s.registerRoute(s.basePath+"/tv/"+action, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				s.methodNotAllowed(w)
				return
			}
			if !s.authorizeTVMutation(w, r) || !s.validEmptyObjectBody(w, r) {
				return
			}
			if s.samsungTV == nil {
				s.writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Samsung TV gateway is unavailable"})
				return
			}
			var err error
			switch action {
			case "start":
				err = s.samsungTV.Start()
			case "stop":
				stopCtx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
				err = s.samsungTV.Stop(stopCtx)
				cancel()
			case "restart":
				stopCtx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
				err = s.samsungTV.Stop(stopCtx)
				cancel()
				if err == nil {
					err = s.samsungTV.Start()
				}
			}
			if errors.Is(err, samsung.ErrAlreadyStarted) || errors.Is(err, samsung.ErrDisabled) {
				s.writeJSON(w, http.StatusConflict, map[string]string{"error": "Samsung TV gateway cannot perform that operation in its current state"})
				return
			}
			if err != nil {
				s.internalError(w, "Samsung TV gateway operation failed")
				return
			}
			s.writeJSON(w, http.StatusAccepted, map[string]string{"state": strings.ToLower(s.samsungTV.Status().State)})
		}))
	}
}

func samsungHLShandler(outputPath string, server *Server) http.Handler {
	root, err := filepath.Abs(outputPath)
	if err != nil {
		return http.NotFoundHandler()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			server.methodNotAllowed(w)
			return
		}
		encodedName := strings.TrimPrefix(r.URL.EscapedPath(), "/tv/live/")
		name, err := url.PathUnescape(encodedName)
		if err != nil || strings.ContainsAny(name, "/\\\x00") || !validSamsungHLSName(name) {
			http.NotFound(w, r)
			return
		}
		rootInfo, err := os.Lstat(root)
		if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
			http.NotFound(w, r)
			return
		}
		rootHandle, err := os.OpenRoot(root)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer rootHandle.Close()
		file, err := rootHandle.Open(name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			_ = file.Close()
			http.NotFound(w, r)
			return
		}
		if name == "index.m3u8" {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		} else {
			w.Header().Set("Content-Type", "video/mp2t")
			w.Header().Set("Cache-Control", "public, max-age=2")
		}
		requestCopy := r.Clone(r.Context())
		requestCopy.URL.Path = "/" + name
		serveOpenedStaticFile(w, requestCopy, file, name, info)
	})
}

func validSamsungHLSName(name string) bool {
	if name == "index.m3u8" {
		return true
	}
	if !strings.HasPrefix(name, "segment_") || !strings.HasSuffix(name, ".ts") {
		return false
	}
	digits := strings.TrimSuffix(strings.TrimPrefix(name, "segment_"), ".ts")
	if len(digits) < 6 {
		return false
	}
	for _, digit := range digits {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}

func (s *Server) authorizeTVMutation(w http.ResponseWriter, r *http.Request) bool {
	manager := s.authManagerSnapshot()
	if manager == nil {
		s.writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "TV management requires API-key authentication"})
		return false
	}
	if hasValidManagementKey(manager, r.Header.Get("X-API-Key")) {
		return true
	}
	s.unauthorized(w)
	return false
}

func (s *Server) validEmptyObjectBody(w http.ResponseWriter, r *http.Request) bool {
	var request struct{}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSON(decoder, &request); err != nil {
		s.badRequest(w, "body must be an empty JSON object")
		return false
	}
	return true
}

func (s *Server) registerRoute(pattern string, handler http.Handler) (registered bool) {
	if pattern == "" || handler == nil {
		return false
	}
	s.routeMu.Lock()
	defer s.routeMu.Unlock()
	if _, exists := s.routes[pattern]; exists {
		return false
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			s.logger.Warn("HTTP route registration rejected", zap.String("pattern", pattern), zap.Any("panic", recovered))
			registered = false
		}
	}()
	s.mux.Handle(pattern, handler)
	s.routes[pattern] = struct{}{}
	return true
}

func (s *Server) staticHandler(prefix, root string, requirePlayback bool) http.Handler {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return http.NotFoundHandler()
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			s.methodNotAllowed(w)
			return
		}
		relativeEscaped := strings.TrimPrefix(r.URL.EscapedPath(), prefix)
		relative, err := url.PathUnescape(relativeEscaped)
		if err != nil || relative == "" || filepath.IsAbs(relative) || strings.ContainsRune(relative, '\x00') {
			http.NotFound(w, r)
			return
		}
		clean := filepath.Clean(filepath.FromSlash(relative))
		if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			http.NotFound(w, r)
			return
		}
		if requirePlayback {
			streamID := strings.Split(filepath.ToSlash(clean), "/")[0]
			if core.ValidateStreamID(streamID) != nil || !s.authorizePlayback(w, r, streamID) {
				if core.ValidateStreamID(streamID) != nil {
					http.NotFound(w, r)
				}
				return
			}
		}

		rootHandle, err := os.OpenRoot(rootAbs)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer rootHandle.Close()
		relativePath := filepath.FromSlash(clean)
		file, err := rootHandle.Open(relativePath)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		info, err := file.Stat()
		if err != nil {
			_ = file.Close()
			http.NotFound(w, r)
			return
		}
		if !info.Mode().IsRegular() && !info.IsDir() {
			_ = file.Close()
			http.NotFound(w, r)
			return
		}
		name := filepath.Base(relativePath)
		if info.IsDir() {
			_ = file.Close()
			indexPath := filepath.Join(relativePath, "index.html")
			file, err = rootHandle.Open(indexPath)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			info, err = file.Stat()
			if err != nil || info.IsDir() || !info.Mode().IsRegular() {
				_ = file.Close()
				http.NotFound(w, r)
				return
			}
			name = filepath.Base(indexPath)
		}
		requestCopy := r.Clone(r.Context())
		requestCopy.URL.Path = "/" + filepath.ToSlash(clean)
		serveOpenedStaticFile(w, requestCopy, file, name, info)
	})
}

func serveStaticFile(w http.ResponseWriter, r *http.Request, path string) {
	abs, err := filepath.Abs(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	root, err := os.OpenRoot(filepath.Dir(abs))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	file, err := root.Open(filepath.Base(abs))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		http.NotFound(w, r)
		return
	}
	serveOpenedStaticFile(w, r, file, filepath.Base(abs), info)
}

func serveOpenedStaticFile(w http.ResponseWriter, r *http.Request, file *os.File, name string, info fs.FileInfo) {
	defer file.Close()
	http.ServeContent(w, r, name, info.ModTime(), file)
}

func validRoutePath(value string) bool {
	if value == "" || value == "/" || strings.TrimSpace(value) != value || !strings.HasPrefix(value, "/") || strings.HasSuffix(value, "/") || strings.Contains(value, "//") || strings.ContainsAny(value, "?#%\\\x00\r\n\t ") {
		return false
	}
	for _, segment := range strings.Split(strings.TrimPrefix(value, "/"), "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func conflictsWithStaticPath(path string) bool {
	for _, prefix := range []string{"/dashboard", "/player", "/hls", "/llhls"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}

func (s *Server) registerRoutes() {
	s.registerRoute("/health", http.HandlerFunc(s.handleHealth))
	s.registerRoute("/health/live", http.HandlerFunc(s.handleHealth))
	s.registerRoute("/health/ready", http.HandlerFunc(s.handleReady))
	s.registerRoute("/ready", http.HandlerFunc(s.handleReady))
	s.registerRoute("/metrics", http.HandlerFunc(s.handleMetrics))
	s.registerRoute(s.basePath+"/info", http.HandlerFunc(s.handleInfo))
	s.registerRoute(s.basePath+"/stats", http.HandlerFunc(s.handleStats))
	s.registerRoute(s.basePath+"/auth/token", http.HandlerFunc(s.handleToken))
	s.registerRoute(s.basePath+"/streams", http.HandlerFunc(s.handleStreams))
	s.registerRoute(s.basePath+"/streams/", http.HandlerFunc(s.handleStreamByID))
}

func (s *Server) Handler() http.Handler {
	return s.corsMiddleware(s.loggingMiddleware(s.securityHeadersMiddleware(s.rateLimitMiddleware(rejectPathTraversal(s.mux)))))
}

func rejectPathTraversal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, err := url.PathUnescape(r.URL.EscapedPath())
		if err != nil || strings.ContainsRune(path, '\x00') {
			http.NotFound(w, r)
			return
		}
		path = strings.ReplaceAll(path, "\\", "/")
		for _, segment := range strings.Split(path, "/") {
			if segment == "." || segment == ".." {
				http.NotFound(w, r)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) Start(addr string) error {
	s.lifecycleMu.Lock()
	server, listener, err := s.prepare(addr)
	s.lifecycleMu.Unlock()
	if err != nil {
		return err
	}
	s.logger.Info("API server started", zap.String("address", addr))
	return s.serve(server, listener)
}

// StartAsync binds synchronously and serves in the background. The returned
// channel receives a non-nil error only if serving fails after the bind.
func (s *Server) StartAsync(addr string) (<-chan error, error) {
	s.lifecycleMu.Lock()
	server, listener, err := s.prepare(addr)
	s.lifecycleMu.Unlock()
	if err != nil {
		return nil, err
	}
	errCh := make(chan error, 1)
	s.logger.Info("API server started", zap.String("address", addr))
	go func() {
		if err := s.serve(server, listener); err != nil {
			errCh <- err
		}
		close(errCh)
	}()
	return errCh, nil
}

func (s *Server) prepare(addr string) (*http.Server, net.Listener, error) {
	s.startMu.Lock()
	if s.httpServer != nil {
		s.startMu.Unlock()
		return nil, nil, fmt.Errorf("API server already started")
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		s.startMu.Unlock()
		return nil, nil, fmt.Errorf("failed to listen on %s: %w", addr, err)
	}
	server := &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: minDuration(s.readTimeout, 10*time.Second),
		ReadTimeout:       s.readTimeout,
		WriteTimeout:      s.writeTimeout,
		IdleTimeout:       s.idleTimeout,
		MaxHeaderBytes:    1 << 20,
	}
	s.httpServer = server
	s.listener = listener
	s.startMu.Unlock()
	return server, listener, nil
}

func (s *Server) serve(server *http.Server, listener net.Listener) error {
	err := server.Serve(listener)
	_ = listener.Close()
	s.clearServer(server)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func minDuration(left, right time.Duration) time.Duration {
	if left <= 0 || left < right {
		return left
	}
	return right
}

func (s *Server) Stop(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	s.startMu.Lock()
	server := s.httpServer
	listener := s.listener
	s.startMu.Unlock()
	if server == nil && listener == nil {
		return nil
	}
	var shutdownErr error
	if server != nil {
		shutdownErr = server.Shutdown(ctx)
		if shutdownErr != nil {
			shutdownErr = errors.Join(shutdownErr, server.Close())
		}
	}
	var closeErr error
	if listener != nil {
		closeErr = listener.Close()
		if errors.Is(closeErr, net.ErrClosed) {
			closeErr = nil
		}
	}
	if server != nil {
		s.clearServer(server)
	}
	return errors.Join(shutdownErr, closeErr)
}

func (s *Server) clearServer(server *http.Server) {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	if s.httpServer == server {
		s.httpServer = nil
		s.listener = nil
	}
}

func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		s.logger.Debug("request",
			zap.String("method", r.Method),
			zap.Int("path_length", len(r.URL.EscapedPath())),
			zap.Duration("duration", time.Since(start)),
		)
	})
}

func (s *Server) securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowed := s.allowedOrigin(origin); allowed != "" {
			w.Header().Set("Access-Control-Allow-Origin", allowed)
			w.Header().Add("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key")

		if r.Method == http.MethodOptions {
			if origin == "" || s.allowedOrigin(origin) == "" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) allowedOrigin(origin string) string {
	if origin == "" {
		return ""
	}
	for _, allowed := range s.config.CORSOrigins {
		if allowed == "*" {
			return "*"
		}
		if origin == allowed {
			return origin
		}
	}
	return ""
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		s.methodNotAllowed(w)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]string{"status": "healthy"})
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		s.methodNotAllowed(w)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) handleStreams(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.listStreams(w)
	case http.MethodPost:
		if s.authorizeMutation(w, r) {
			s.createStream(w, r)
		}
	default:
		s.methodNotAllowed(w)
	}
}

func (s *Server) handleStreamByID(w http.ResponseWriter, r *http.Request) {
	encodedID := strings.TrimPrefix(r.URL.EscapedPath(), s.basePath+"/streams/")
	streamID, err := url.PathUnescape(encodedID)
	if err != nil || core.ValidateStreamID(streamID) != nil {
		s.badRequest(w, "valid stream ID required")
		return
	}

	switch r.Method {
	case http.MethodGet:
		s.getStream(w, streamID)
	case http.MethodDelete:
		if s.authorizeMutation(w, r) {
			s.deleteStream(w, streamID)
		}
	default:
		s.methodNotAllowed(w)
	}
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	s.metricsMu.RLock()
	enabled, path := s.metricsEnabled, s.metricsPath
	s.metricsMu.RUnlock()
	if !enabled || r.URL.Path != path {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		s.methodNotAllowed(w)
		return
	}
	streams := s.registry.List()
	viewers := 0
	for _, stream := range streams {
		viewers += stream.Viewers
	}
	s.metrics.SetCurrentState(s.registry.LiveCount(), viewers)
	s.metrics.Handler().ServeHTTP(w, r)
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.methodNotAllowed(w)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"name":       "STREMDBC",
		"version":    s.versionSnapshot(),
		"go_version": runtime.Version(),
		"goroutines": runtime.NumGoroutine(),
		"cpus":       runtime.NumCPU(),
		"uptime":     time.Since(s.startedAt).Round(time.Second).String(),
	})
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.methodNotAllowed(w)
		return
	}
	streams := s.registry.List()
	viewers := 0
	for _, stream := range streams {
		viewers += stream.Viewers
	}

	components := make(map[string]interface{})
	providers := make(map[string]func() map[string]interface{})
	s.statsMu.RLock()
	for name, provider := range s.componentStats {
		providers[name] = provider
	}
	s.statsMu.RUnlock()
	for name, provider := range providers {
		components[name] = provider()
	}
	s.metrics.SetCurrentState(s.registry.LiveCount(), viewers)

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"streams":        len(streams),
		"live_streams":   s.registry.LiveCount(),
		"viewers":        viewers,
		"goroutines":     runtime.NumGoroutine(),
		"memory_bytes":   mem.Alloc,
		"uptime_seconds": int64(time.Since(s.startedAt).Seconds()),
		"components":     components,
	})
}

func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.methodNotAllowed(w)
		return
	}
	manager := s.authManagerSnapshot()
	if manager == nil {
		s.writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "authentication is disabled"})
		return
	}
	if !hasValidManagementKey(manager, r.Header.Get("X-API-Key")) {
		s.unauthorized(w)
		return
	}

	var req struct {
		StreamID string `json:"stream_id"`
		Action   string `json:"action"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSON(decoder, &req); err != nil {
		s.badRequest(w, "invalid request body")
		return
	}

	var (
		token string
		err   error
	)
	switch req.Action {
	case "publish":
		token, err = manager.GeneratePublishToken(req.StreamID, r.Header.Get("X-API-Key"), s.clientIP(r))
	case "play":
		token, err = manager.GeneratePlayToken(req.StreamID, s.clientIP(r))
	default:
		s.badRequest(w, "action must be publish or play")
		return
	}
	if err != nil {
		s.badRequest(w, err.Error())
		return
	}
	s.writeJSON(w, http.StatusCreated, map[string]string{"token": token, "action": req.Action, "stream_id": req.StreamID})
}

func (s *Server) authorizeMutation(w http.ResponseWriter, r *http.Request) bool {
	manager := s.authManagerSnapshot()
	if manager == nil {
		return true
	}
	if hasValidManagementKey(manager, r.Header.Get("X-API-Key")) {
		return true
	}
	s.unauthorized(w)
	return false
}

func hasValidManagementKey(manager *auth.Manager, key string) bool {
	return manager != nil && strings.TrimSpace(key) != "" && manager.ValidateAPIKey(key)
}

func (s *Server) listStreams(w http.ResponseWriter) {
	streams := s.registry.List()
	s.writeJSON(w, http.StatusOK, map[string]interface{}{"streams": streams, "count": len(streams)})
}

func (s *Server) createStream(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSON(decoder, &req); err != nil {
		s.badRequest(w, "invalid request body")
		return
	}
	req.ID = strings.TrimSpace(req.ID)
	if err := core.ValidateStreamID(req.ID); err != nil {
		s.badRequest(w, "valid stream ID required")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		req.Name = req.ID
	}

	stream, err := s.registry.Register(req.ID, req.Name)
	if err != nil {
		if errors.Is(err, core.ErrStreamExists) {
			s.conflict(w, "stream already exists")
			return
		}
		if errors.Is(err, core.ErrInvalidStreamID) || strings.Contains(err.Error(), "stream name") {
			s.badRequest(w, err.Error())
			return
		}
		s.internalError(w, "failed to create stream")
		return
	}
	s.metrics.RecordStreamCreated()
	s.logger.Info("stream created")
	s.writeJSON(w, http.StatusCreated, stream)
}

func (s *Server) getStream(w http.ResponseWriter, id string) {
	stream, exists := s.registry.Get(id)
	if !exists {
		s.notFound(w, "stream not found")
		return
	}
	s.writeJSON(w, http.StatusOK, stream)
}

func (s *Server) deleteStream(w http.ResponseWriter, id string) {
	if err := s.registry.Delete(id); err != nil {
		if errors.Is(err, core.ErrStreamNotFound) {
			s.notFound(w, "stream not found")
			return
		}
		if errors.Is(err, core.ErrStreamActive) {
			s.conflict(w, "stream is active")
			return
		}
		s.internalError(w, "failed to delete stream")
		return
	}
	s.logger.Info("stream deleted")
	w.WriteHeader(http.StatusNoContent)
}

func directClientIP(r *http.Request) string {
	remote := r.RemoteAddr
	if host, _, err := net.SplitHostPort(remote); err == nil {
		return host
	}
	return remote
}

func parseTrustedProxies(values []string) []*net.IPNet {
	result := make([]*net.IPNet, 0, len(values))
	for _, value := range values {
		if ip := net.ParseIP(value); ip != nil {
			bits := 128
			if ip.To4() != nil {
				bits = 32
			}
			result = append(result, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}
		if _, network, err := net.ParseCIDR(value); err == nil {
			result = append(result, network)
		}
	}
	return result
}

func (s *Server) clientIP(r *http.Request) string {
	remote := directClientIP(r)
	ip := net.ParseIP(remote)
	trusted := false
	for _, network := range s.trustedProxies {
		if ip != nil && network.Contains(ip) {
			trusted = true
			break
		}
	}
	if !trusted {
		return remote
	}
	if candidate := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); net.ParseIP(candidate) != nil {
		return candidate
	}
	for _, candidate := range strings.Split(r.Header.Get("X-Forwarded-For"), ",") {
		candidate = strings.TrimSpace(candidate)
		if net.ParseIP(candidate) != nil {
			return candidate
		}
	}
	return remote
}

func (s *Server) rateLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.rateLimit <= 0 || (r.URL.Path != s.basePath && !strings.HasPrefix(r.URL.Path, s.basePath+"/")) {
			next.ServeHTTP(w, r)
			return
		}

		key := s.clientIP(r)
		now := time.Now()
		limited := false

		s.rateMu.Lock()
		entry := s.rateEntries[key]
		if entry == nil || now.Sub(entry.windowStart) >= time.Minute {
			entry = &rateEntry{windowStart: now}
			s.rateEntries[key] = entry
		}
		if entry.count >= s.rateLimit {
			limited = true
		} else {
			entry.count++
		}
		if len(s.rateEntries) > 4096 {
			for candidate, value := range s.rateEntries {
				if now.Sub(value.windowStart) >= 2*time.Minute {
					delete(s.rateEntries, candidate)
				}
			}
		}
		s.rateMu.Unlock()

		if limited {
			w.Header().Set("Retry-After", "60")
			s.writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limit exceeded"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func decodeSingleJSON(decoder *json.Decoder, destination interface{}) error {
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra interface{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values")
		}
		return err
	}
	return nil
}

func (s *Server) authorizePlayback(w http.ResponseWriter, r *http.Request, streamID string) bool {
	manager := s.authManagerSnapshot()
	if manager == nil || manager.AllowAnonymous() {
		return true
	}
	tokenString := r.URL.Query().Get("token")
	if tokenString == "" {
		const bearerPrefix = "Bearer "
		authorization := r.Header.Get("Authorization")
		if strings.HasPrefix(authorization, bearerPrefix) {
			tokenString = strings.TrimSpace(strings.TrimPrefix(authorization, bearerPrefix))
		}
	}
	claims, err := manager.ValidateToken(tokenString)
	if err != nil || !manager.CanPlayFromIP(claims, streamID, s.clientIP(r)) {
		s.unauthorized(w)
		return false
	}
	return true
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		s.logger.Error("encode response", zap.Error(err))
	}
}

func (s *Server) badRequest(w http.ResponseWriter, message string) {
	s.writeJSON(w, http.StatusBadRequest, map[string]string{"error": message})
}

func (s *Server) unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", "ApiKey")
	s.writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}

func (s *Server) notFound(w http.ResponseWriter, message string) {
	s.writeJSON(w, http.StatusNotFound, map[string]string{"error": message})
}

func (s *Server) conflict(w http.ResponseWriter, message string) {
	s.writeJSON(w, http.StatusConflict, map[string]string{"error": message})
}

func (s *Server) methodNotAllowed(w http.ResponseWriter) {
	s.writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
}

func (s *Server) internalError(w http.ResponseWriter, message string) {
	s.writeJSON(w, http.StatusInternalServerError, map[string]string{"error": message})
}

func (s *Server) String() string {
	return fmt.Sprintf("STREMDBC API %s", s.versionSnapshot())
}
