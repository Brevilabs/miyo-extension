# Stable extension ID

`public/manifest.json` carries a `"key"` field — the base64 DER-encoded RSA
public key — so the extension ID is the same everywhere (unpacked dev loads,
CI builds, and the Chrome Web Store listing). Miyo Desktop pins this ID: the
local service only accepts `POST /v0/chats/cookies` from allow-listed
`chrome-extension://` origins (`MIYO_EXTENSION_ORIGINS`), so the ID must not
drift between builds.

- **Extension ID:** `pmkapnocjgmigkeffplajjfbcmhmjfde`
- **Origin:** `chrome-extension://pmkapnocjgmigkeffplajjfbcmhmjfde`

The ID is derived from the public key: first 16 bytes of SHA-256 over the DER
public key, hex digits mapped `0-9a-f` → `a-p`.

## Private key

The private key is **not** in this repo and must never be committed. It lives
outside the working tree (e.g. `~/miyo-extension-private-key.pem` on the
maintainer's machine). It was generated with:

```bash
openssl genrsa -out miyo-extension-private-key.pem 2048
```

To re-derive the manifest `key` value and the extension ID from it:

```bash
# manifest "key"
openssl rsa -in miyo-extension-private-key.pem -pubout -outform DER | base64

# extension ID
openssl rsa -in miyo-extension-private-key.pem -pubout -outform DER \
  | shasum -a 256 | cut -c1-32 | tr '0-9a-f' 'a-p'
```

If the private key is ever lost, the manifest `key` (and therefore the ID)
can stay as-is — the `key` field alone pins the ID for unpacked and store
builds. The private key is only needed for `.crx` packaging outside the
store.
