const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const nacl = require('../public/vendor/nacl-fast-1.0.3.min.js');
const source = fs.readFileSync(require.resolve('../public/wallet-links.js'), 'utf8');
const KEY = 'torrino.wallet-link.v1';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encode(bytes) {
  let value = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (value) { out = alphabet[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte) break; out = '1' + out; }
  return out;
}
function decode(str) {
  let n = 0n;
  for (const char of str) n = n * 58n + BigInt(alphabet.indexOf(char));
  const bytes = [];
  while (n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const char of str) { if (char !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
function browser(storage = new Map(), href = 'https://happydev.fi/torrino.dao.voting/') {
  const location = { href, protocol: new URL(href).protocol, origin: new URL(href).origin, pathname: new URL(href).pathname, assign(url) { this.assigned = url; } };
  const context = { URL, URLSearchParams, Uint8Array, TextEncoder, TextDecoder, nacl, crypto: crypto.webcrypto, location,
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    history: { replaceState(_a,_b,url) { location.href = url; } } };
  context.window = context;
  vm.runInNewContext(source, context);
  return { api: context.WalletLinks, location, storage, context };
}
function reply(link, body, shared, extra = {}) {
  const url = new URL(link.searchParams.get('redirect_link'));
  const nonce = nacl.randomBytes(24);
  url.searchParams.set('nonce', encode(nonce));
  url.searchParams.set('data', encode(nacl.box.after(new TextEncoder().encode(JSON.stringify(body)), nonce, shared)));
  for (const [k,v] of Object.entries(extra)) url.searchParams.set(k,v);
  return url.href;
}
function connected(wallet) {
  const start = browser();
  start.api.connect(wallet);
  const link = new URL(start.location.assigned);
  assert.equal(link.origin, wallet === 'phantom' ? 'https://phantom.com' : 'https://solflare.com');
  assert.equal(link.pathname, '/ul/v1/connect');
  assert.equal(link.searchParams.get('cluster'), 'mainnet-beta');
  const pair = nacl.box.keyPair();
  const signer = nacl.sign.keyPair();
  const address = encode(signer.publicKey);
  const shared = nacl.box.before(decode(link.searchParams.get('dapp_encryption_public_key')), pair.secretKey);
  const callbackURL = reply(link, { public_key: address, session: 'test-session' }, shared, { [`${wallet}_encryption_public_key`]: encode(pair.publicKey) });
  const returned = browser(start.storage, callbackURL); // Simulates reload / different tab.
  const result = returned.api.handleCallback();
  assert.equal(result.provider.publicKey, address);
  assert.equal(new URL(returned.location.href).search, '');
  assert.equal(JSON.parse(start.storage.get(KEY)).secretKey, undefined);
  return { ...returned, signer, shared, address, callbackURL };
}
for (const wallet of ['phantom', 'solflare']) {
  test(`${wallet}: encrypted connect, signature, reload, replay protection and disconnect`, async () => {
    const env = connected(wallet);
    const provider = browser(env.storage).api.restore();
    assert.equal((await provider.connect()).publicKey, env.address);
    const message = 'Torrino DAO governance vote:option:SÌ ✅';
    const vote = { proposalId: 'proposal-1', voteOption: 'SÌ ✅', message, wallet: env.address };
    env.api.restore().requestSignature(new TextEncoder().encode(message), vote);
    const link = new URL(env.location.assigned);
    assert.equal(link.pathname, '/ul/v1/signMessage');
    const payload = JSON.parse(new TextDecoder().decode(nacl.box.open.after(decode(link.searchParams.get('payload')), decode(link.searchParams.get('nonce')), env.shared)));
    assert.equal(new TextDecoder().decode(decode(payload.message)), message);
    assert.equal(payload.session, 'test-session');
    assert.equal(payload.display, 'utf8');
    const signature = encode(nacl.sign.detached(new TextEncoder().encode(message), env.signer.secretKey));
    const callbackURL = reply(link, { signature }, env.shared);
    const returned = browser(env.storage, callbackURL);
    const result = returned.api.handleCallback();
    assert.deepEqual(JSON.parse(JSON.stringify(result.vote)), { ...vote, signature });
    assert.throws(() => browser(env.storage, callbackURL).api.handleCallback(), /WALLET_CALLBACK_MISSING/);
    await returned.api.restore().disconnect();
    assert.equal(returned.api.restore(), null);
    assert.equal(env.storage.size, 0);
  });
}
test('reject altered encrypted response and consume it once', () => {
  const env = connected('phantom');
  env.api.restore().requestSignature(new TextEncoder().encode('message'), { message: 'message', wallet: env.address });
  const url = new URL(reply(new URL(env.location.assigned), { signature: encode(nacl.randomBytes(64)) }, nacl.randomBytes(32)));
  assert.throws(() => browser(env.storage, url.href).api.handleCallback(), /WALLET_LINK_INVALID/);
  assert.throws(() => browser(env.storage, url.href).api.handleCallback(), /WALLET_CALLBACK_MISSING/);
});
test('reject signature for a different message even with valid response encryption', () => {
  const env = connected('solflare');
  env.api.restore().requestSignature(new TextEncoder().encode('expected'), { message: 'expected', wallet: env.address });
  const signature = encode(nacl.sign.detached(new TextEncoder().encode('other'), env.signer.secretKey));
  const url = reply(new URL(env.location.assigned), { signature }, env.shared);
  assert.throws(() => browser(env.storage, url).api.handleCallback(), /WALLET_LINK_INVALID/);
});
test('cancellation preserves connected wallet, clears pending request, allows retry', () => {
  const env = connected('phantom');
  env.api.restore().requestSignature(new TextEncoder().encode('vote'), { message: 'vote', wallet: env.address });
  const url = new URL(new URL(env.location.assigned).searchParams.get('redirect_link'));
  url.searchParams.set('errorCode', '4001');
  const returned = browser(env.storage, url.href);
  assert.throws(() => returned.api.handleCallback(), /WALLET_REQUEST_REJECTED/);
  assert.equal(returned.api.restore().publicKey, env.address);
  assert.equal(JSON.parse(env.storage.get(KEY)).pending, undefined);
  returned.api.restore().requestSignature(new TextEncoder().encode('retry'), { message: 'retry', wallet: env.address });
  assert.ok(returned.location.assigned);
});
test('expired requests, mismatched request IDs, missing browser storage and expired sessions', () => {
  const env = connected('phantom');
  env.api.restore().requestSignature(new TextEncoder().encode('vote'), { message: 'vote', wallet: env.address });
  const url = new URL(new URL(env.location.assigned).searchParams.get('redirect_link'));
  assert.throws(() => browser(new Map(), url.href).api.handleCallback(), /WALLET_CALLBACK_MISSING/);
  const bad = new URL(url); bad.searchParams.set('wallet_request', 'wrong');
  assert.throws(() => browser(env.storage, bad.href).api.handleCallback(), /WALLET_CALLBACK_MISSING/);
  const record = JSON.parse(env.storage.get(KEY));
  assert.ok(record.pending);
  record.pending.createdAt = Date.now() - 301000;
  env.storage.set(KEY, JSON.stringify(record));
  assert.throws(() => browser(env.storage, url.href).api.handleCallback(), /WALLET_REQUEST_EXPIRED/);
  record.expiresAt = Date.now() - 1;
  env.storage.set(KEY, JSON.stringify(record));
  assert.equal(env.api.restore(), null);
  assert.equal(env.storage.size, 0);
});
test('fail before navigating if browser storage is blocked or HTTPS is absent', () => {
  const env = browser();
  env.context.localStorage.setItem = () => { throw Error('blocked'); };
  assert.throws(() => env.api.connect('phantom'), /WALLET_STORAGE_UNAVAILABLE/);
  assert.equal(env.location.assigned, undefined);
  const http = browser(new Map(), 'http://localhost/');
  assert.throws(() => http.api.connect('solflare'), /WALLET_HTTPS_REQUIRED/);
  assert.equal(http.location.assigned, undefined);
});
