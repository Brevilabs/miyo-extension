# Stable extension ID

`public/manifest.json` carries a `"key"` field — the base64 DER-encoded RSA
public key — so the extension ID is the same everywhere (unpacked dev loads,
CI builds, and the Chrome Web Store listing). Miyo Desktop pins this ID: the
desktop's native-messaging host manifest (`md.miyo.chatsync`) lists this
extension in its `allowed_origins`
(`["chrome-extension://ahgkkpcooanimmhhncdkgeojacjhmaeg/"]`). Chrome only lets
an extension connect to a native host whose manifest allow-lists its origin,
so the ID must not drift between builds — otherwise the host connection is
refused.

- **Extension ID:** `ahgkkpcooanimmhhncdkgeojacjhmaeg`
- **Origin:** `chrome-extension://ahgkkpcooanimmhhncdkgeojacjhmaeg`

The ID is derived from the public key: first 16 bytes of SHA-256 over the DER
public key, hex digits mapped `0-9a-f` → `a-p`.

## The key is owned by the Chrome Web Store

This item was first published (v0.3.1–v0.3.4) **without** a `key` field, so the
Chrome Web Store generated the key pair and assigned the permanent ID
`ahgkkpcooanimmhhncdkgeojacjhmaeg`. That ID is immutable for the listing — it
is the one existing users already have.

The `key` value in `public/manifest.json` is the store item's **public** key,
recovered from the published `.crx`. Pinning it makes unpacked/CI builds resolve
to the same store ID (needed so native messaging works in dev). The matching
**private** key is held by Google; we don't have it and don't need it — store
distribution is signed by Google, and unpacked loads only need the public `key`
to derive the ID.

> Historical note: an earlier draft of v0.3.5 shipped a locally-generated `key`
> (ID `pmkapnocjgmigkeffplajjfbcmhmjfde`). That key never matched the store item,
> so uploads were rejected with "key field value in the manifest doesn't match
> the current item." It has been replaced with the real store key above. Any
> `~/miyo-extension-private-key.pem` from that attempt is orphaned and unused.

To re-derive the public `key` and the ID from the published listing:

```bash
# download the published crx
curl -sL "https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=120&x=id%3Dahgkkpcooanimmhhncdkgeojacjhmaeg%26installsource%3Dondemand%26uc" -o ext.crx

# the manifest "key" is the CRX3 proof whose SHA-256 matches the crx_id in the
# signed header (see scripts/ or the parse used in the PR that fixed this).
```

Equivalently, load the live item from the store and read the `key` field that
Chrome injects into the installed copy's `manifest.json`.
