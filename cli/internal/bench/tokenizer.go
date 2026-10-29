package bench

import (
	"errors"
	"runtime/debug"

	"github.com/tiktoken-go/tokenizer/codec"
)

func newCounter(encoding string) (*codec.Codec, error) {
	/** Constructors load their vocabulary lazily, so ordinary browser commands never initialize it. */
	switch encoding {
	case O200kBase:
		return codec.NewO200kBase(), nil
	case Cl100kBase:
		return codec.NewCl100kBase(), nil
	default:
		return nil, errors.New("unsupported tokenizer encoding")
	}
}

func tokenizerInfo(encoding string) TokenizerInfo {
	const module = "github.com/tiktoken-go/tokenizer"
	version := "unknown"
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dependency := range info.Deps {
			if dependency.Path == module {
				version = dependency.Version
			}
		}
	}
	return TokenizerInfo{Implementation: module, Version: version, Encoding: encoding, SpecialTokens: "ordinary_text"}
}
