//go:build ignore

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	if err := vendor(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func vendor() error {
	root := filepath.Join("internal", "devtools", "pages", "vendor")
	if err := os.MkdirAll(root, 0755); err != nil {
		return err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	manifest := map[string]any{}
	for _, name := range []string{"react", "react-dom"} {
		const version = "18.3.1"
		metadataURL := "https://registry.npmjs.org/" + name + "/" + version
		metadata, err := get(client, metadataURL)
		if err != nil {
			return err
		}
		var info struct{ Dist struct{ Integrity string } }
		if err := json.Unmarshal(metadata, &info); err != nil {
			return err
		}
		archiveURL := "https://registry.npmjs.org/" + name + "/-/" + name + "-" + version + ".tgz"
		archive, err := get(client, archiveURL)
		if err != nil {
			return err
		}
		sum := sha512.Sum512(archive)
		if info.Dist.Integrity != "sha512-"+base64.StdEncoding.EncodeToString(sum[:]) {
			return fmt.Errorf("fixture package integrity mismatch")
		}
		compressed, err := gzip.NewReader(bytes.NewReader(archive))
		if err != nil {
			return err
		}
		reader := tar.NewReader(compressed)
		wanted := map[string]string{"package/umd/" + name + ".production.min.js": name + ".js", "package/LICENSE": name + ".LICENSE"}
		hashes := map[string]string{}
		for {
			header, err := reader.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			file, exists := wanted[header.Name]
			if !exists {
				continue
			}
			data, err := io.ReadAll(io.LimitReader(reader, 2<<20))
			if err != nil {
				return err
			}
			if int64(len(data)) != header.Size || header.Typeflag != tar.TypeReg {
				return fmt.Errorf("invalid fixture vendor file")
			}
			if err := os.WriteFile(filepath.Join(root, file), data, 0644); err != nil {
				return err
			}
			hash := sha256.Sum256(data)
			hashes[file] = hex.EncodeToString(hash[:])
		}
		_ = compressed.Close()
		if len(hashes) != 2 {
			return fmt.Errorf("fixture vendor files missing")
		}
		manifest[name] = map[string]any{"version": version, "source": archiveURL, "integrity": info.Dist.Integrity, "sha256": hashes}
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, "manifest.json"), append(data, '\n'), 0644)
}

func get(client *http.Client, uri string) ([]byte, error) {
	if !strings.HasPrefix(uri, "https://registry.npmjs.org/") {
		return nil, fmt.Errorf("unexpected fixture package host")
	}
	response, err := client.Get(uri)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("fixture package download failed: HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil || len(data) == 8<<20 {
		return nil, fmt.Errorf("fixture package exceeds download budget")
	}
	return data, nil
}
