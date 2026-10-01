package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"

	"github.com/elysia-api/backend/config"
)

// Run the real server in a child so stdin, signals and all background workers
// have their production lifetime, while every writable path stays in TempDir.
func TestParentStdinEOF(t *testing.T) {
	for _, tc := range []struct {
		name         string
		value        string
		immediate    bool
		shutdownHTTP bool
		signal       bool
	}{
		{name: "desktop", value: "1"},
		{name: "already-closed-at-startup", value: "1", immediate: true},
		{name: "desktop-http-shutdown", value: "1", shutdownHTTP: true},
		{name: "desktop-signal-shutdown", value: "1", signal: true},
		{name: "default-cli"},
		{name: "requires-exact-opt-in", value: "true"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.signal && runtime.GOOS == "windows" {
				t.Skip("Windows does not support sending SIGTERM to a child")
			}
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			addr := listener.Addr().String()
			port := listener.Addr().(*net.TCPAddr).Port
			listener.Close()
			configPath := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(configPath, []byte(fmt.Sprintf(`{"server":{"host":"127.0.0.1","port":%d},"panelAccessToken":"eof-test","openBrowserOnStart":false,"modelCatalog":{"enabled":false}}`, port)), 0600); err != nil {
				t.Fatal(err)
			}

			stdin, parent, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer stdin.Close()
			defer parent.Close()
			var output bytes.Buffer
			cmd := exec.Command(os.Args[0], "-test.run=^TestParentStdinEOFHelper$")
			cmd.Env = append(os.Environ(), "ELYSIA_API_EOF_TEST_CONFIG="+configPath, "ELYSIA_API_SHUTDOWN_ON_STDIN_EOF="+tc.value)
			cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, &output, &output
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			finished := false
			t.Cleanup(func() {
				if !finished {
					cmd.Process.Kill()
					<-done
				}
			})
			waitForExit := func() {
				t.Helper()
				select {
				case err := <-done:
					finished = true
					if err != nil {
						t.Fatalf("server exit: %v\n%s", err, &output)
					}
				case <-time.After(10 * time.Second):
					t.Fatal("server did not finish graceful shutdown")
				}
			}

			if tc.immediate {
				parent.Close()
				waitForExit()
				return
			}
			client := &http.Client{Timeout: time.Second}
			deadline := time.Now().Add(10 * time.Second)
			for {
				response, err := client.Get("http://" + addr + "/health")
				if err == nil {
					response.Body.Close()
					if response.StatusCode != http.StatusOK {
						t.Fatalf("health returned %d", response.StatusCode)
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("server was not ready: %v", err)
				}
				time.Sleep(10 * time.Millisecond)
			}
			request, _ := http.NewRequest(http.MethodGet, "http://"+addr+"/api/admin/health", nil)
			request.Header.Set("Authorization", "Bearer eof-test")
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			var health struct {
				Data struct {
					ProcessID int `json:"processID"`
				} `json:"data"`
			}
			err = json.NewDecoder(response.Body).Decode(&health)
			response.Body.Close()
			if err != nil || health.Data.ProcessID != cmd.Process.Pid {
				t.Fatalf("admin health must identify the owned child: processID=%d, want=%d, error=%v", health.Data.ProcessID, cmd.Process.Pid, err)
			}
			if tc.signal {
				if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
					t.Fatal(err)
				}
				waitForExit()
				return
			}
			// Data on the lifetime pipe must not be mistaken for its EOF.
			if _, err := parent.Write([]byte("still here\n")); err != nil {
				t.Fatal(err)
			}
			if !tc.shutdownHTTP {
				parent.Close()
			}
			if tc.value != "1" || tc.shutdownHTTP {
				select {
				case err := <-done:
					finished = true
					t.Fatalf("CLI stopped on stdin EOF: %v\n%s", err, &output)
				case <-time.After(150 * time.Millisecond):
				}
				response, err := client.Post("http://"+addr+"/__shutdown", "application/json", nil)
				if err != nil {
					t.Fatal(err)
				}
				response.Body.Close()
			}
			waitForExit()
		})
	}
}

func TestParentStdinEOFHelper(t *testing.T) {
	path := os.Getenv("ELYSIA_API_EOF_TEST_CONFIG")
	if path == "" {
		return
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := New(cfg).ListenAndServe(); err != nil {
		t.Fatal(err)
	}
}
