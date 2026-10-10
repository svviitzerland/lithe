package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io"

	"golang.org/x/crypto/hkdf"
	gossh "golang.org/x/crypto/ssh"
)

// DeriveHostKey builds a stable ed25519 host key from a secret seed and a label.
//
// The point is that the relay stores no key material: give the same --seed and
// you get the same fingerprint, on any machine, forever. Redeploy the relay and
// clients see no host-key warning.
//
// Note it is per-relay, not per-app: SSH sends the host key during key exchange,
// before the username is known, so username-routed apps necessarily share one
// host identity. Per-app keys require per-app addresses (see docs/VANITY.md).
func DeriveHostKey(seed, label string) (gossh.Signer, error) {
	if seed == "" {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		seed = hex.EncodeToString(b)
	}
	kdf := hkdf.New(sha256.New, []byte(seed), []byte("lithe-hostkey-v1"), []byte(label))
	priv := make([]byte, ed25519.SeedSize)
	if _, err := io.ReadFull(kdf, priv); err != nil {
		return nil, err
	}
	return gossh.NewSignerFromKey(ed25519.NewKeyFromSeed(priv))
}

// Fingerprint renders the SHA256 fingerprint OpenSSH shows on first connect.
func Fingerprint(s gossh.Signer) string {
	return gossh.FingerprintSHA256(s.PublicKey())
}
