package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/elysia-api/backend/config"
)

func TestDesktopOriginIsOptInAndKeepsPanelAuthentication(t *testing.T) {
	for _, mode := range []string{"", "true", "1"} {
		t.Run("mode="+mode, func(t *testing.T) {
			t.Setenv("ELYSIA_API_DESKTOP_ORIGIN", mode)
			cfg := &config.Config{DatabasePath: filepath.Join(t.TempDir(), "data.sqlite3"), PanelAccessToken: "desktop-test"}
			s := New(cfg)
			if s.startupErr != nil {
				t.Fatal(s.startupErr)
			}
			defer s.store.Close()
			defer s.doShutdown()
			s.setupRoutes()
			for _, origin := range []string{"tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://tauri.localhost.evil.test", "https://example.com", "null"} {
				t.Run(origin, func(t *testing.T) {
					allowed := mode == "1" && (origin == "tauri://localhost" || origin == "http://tauri.localhost" || origin == "https://tauri.localhost")
					request := httptest.NewRequest(http.MethodOptions, "/api/admin/runtime-config", nil)
					request.Header.Set("Origin", origin)
					request.Header.Set("Access-Control-Request-Method", "PUT")
					request.Header.Set("Access-Control-Request-Headers", "authorization, Content-Type")
					response := httptest.NewRecorder()
					s.engine.ServeHTTP(response, request)
					if allowed {
						if response.Code != http.StatusNoContent || response.Header().Get("Access-Control-Allow-Origin") != origin {
							t.Fatalf("allowed preflight rejected: %d %v", response.Code, response.Header())
						}
					} else if response.Header().Get("Access-Control-Allow-Origin") != "" || response.Code == http.StatusNoContent {
						t.Fatalf("unexpected CORS access: %d %v", response.Code, response.Header())
					}
					for _, token := range []string{"", "desktop-test"} {
						request := httptest.NewRequest(http.MethodGet, "/api/admin/health", nil)
						request.Header.Set("Origin", origin)
						if token != "" {
							request.Header.Set("Authorization", "Bearer "+token)
						}
						response := httptest.NewRecorder()
						s.engine.ServeHTTP(response, request)
						want := http.StatusOK
						if token == "" {
							want = http.StatusUnauthorized
						}
						if response.Code != want {
							t.Fatalf("panel auth changed: got=%d want=%d", response.Code, want)
						}
						if allowed != (response.Header().Get("Access-Control-Allow-Origin") == origin) {
							t.Fatalf("unexpected origin response: %v", response.Header())
						}
					}
				})
			}
			request := httptest.NewRequest(http.MethodGet, "/health", nil)
			response := httptest.NewRecorder()
			s.engine.ServeHTTP(response, request)
			if response.Code != http.StatusOK || response.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatalf("ordinary health request changed: %d %v", response.Code, response.Header())
			}
		})
	}
}
