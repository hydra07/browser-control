package devtools

import (
	"embed"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"
)

//go:embed pages/*.html pages/vendor/*
var pages embed.FS

var fixtureNames = []string{"react-admin", "article", "virtual-table", "realtime-dashboard", "modal", "form", "nested-frames", "shadow-dom", "duplicate-controls", "navigation"}

type FixtureServer struct {
	BaseURL  string
	server   *http.Server
	listener net.Listener
}

func FixtureNames() []string { return slices.Clone(fixtureNames) }

func StartFixtureServer() (*FixtureServer, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, errors.New("cannot start loopback fixture server")
	}
	files, err := fs.Sub(pages, "pages")
	if err != nil {
		_ = listener.Close()
		return nil, err
	}
	handler := http.FileServerFS(files)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		handler.ServeHTTP(w, r)
	}), ReadHeaderTimeout: 3 * time.Second, IdleTimeout: 3 * time.Second}
	fixture := &FixtureServer{BaseURL: "http://" + listener.Addr().String(), server: server, listener: listener}
	go func() { _ = server.Serve(listener) }()
	return fixture, nil
}

func (s *FixtureServer) URL(name string) (string, error) {
	if !slices.Contains(fixtureNames, name) {
		return "", errors.New("unknown synthetic fixture; available: " + strings.Join(fixtureNames, ", "))
	}
	return s.BaseURL + "/" + name + ".html", nil
}

func (s *FixtureServer) Close() error { return s.server.Close() }
