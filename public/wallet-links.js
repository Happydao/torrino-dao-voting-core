/* Phantom / Solflare encrypted universal links. No wallet private keys are stored.
 * Local storage allows an HTTPS callback to open in a new tab of the same browser.
 * The stored secret is only the temporary dapp encryption key, never a signing key.
 */
(() => {
  "use strict";
  const STORAGE_KEY = "torrino.wallet-link.v1";
  const SESSION_TTL = 12 * 60 * 60 * 1000;
  const REQUEST_TTL = 5 * 60 * 1000;
  const BASES = { phantom: "https://phantom.com/ul/v1/", solflare: "https://solflare.com/ul/v1/" };
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const CALLBACK_PARAMS = ["wallet_callback", "wallet_request", "phantom_encryption_public_key", "solflare_encryption_public_key", "nonce", "data", "errorCode", "errorMessage"];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function encode(bytes) {
    let value = 0n;
    for (const byte of bytes) value = value * 256n + BigInt(byte);
    let result = "";
    while (value) {
      result = ALPHABET[Number(value % 58n)] + result;
      value /= 58n;
    }
    for (const byte of bytes) {
      if (byte !== 0) break;
      result = "1" + result;
    }
    return result;
  }

  function decode(value) {
    if (typeof value !== "string" || !value || value.length > 20000) throw new Error("WALLET_LINK_INVALID");
    let number = 0n;
    for (const char of value) {
      const digit = ALPHABET.indexOf(char);
      if (digit < 0) throw new Error("WALLET_LINK_INVALID");
      number = number * 58n + BigInt(digit);
    }
    const bytes = [];
    while (number) {
      bytes.push(Number(number % 256n));
      number /= 256n;
    }
    for (const char of value) {
      if (char !== "1") break;
      bytes.push(0);
    }
    return Uint8Array.from(bytes.reverse());
  }

  function forget() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* Storage may be disabled. */ }
  }

  function read() {
    try {
      const record = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!record) return null;
      if (!Object.hasOwn(BASES, record.wallet) || !(record.expiresAt > Date.now())) {
        forget();
        return null;
      }
      return record;
    } catch (_) {
      forget();
      return null;
    }
  }

  function write(record) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(record)); }
    catch (_) { throw new Error("WALLET_STORAGE_UNAVAILABLE"); }
  }

  function requireCrypto() {
    if (!window.nacl || !window.crypto || !window.crypto.getRandomValues) throw new Error("WALLET_CRYPTO_UNAVAILABLE");
  }

  function request(record, method, payload, vote) {
    requireCrypto();
    if (location.protocol !== "https:") throw new Error("WALLET_HTTPS_REQUIRED");
    const id = encode(nacl.randomBytes(24));
    const redirect = new URL(location.href);
    for (const key of CALLBACK_PARAMS) redirect.searchParams.delete(key);
    redirect.hash = "";
    redirect.searchParams.set("wallet_callback", method);
    redirect.searchParams.set("wallet_request", id);
    const link = new URL(method, BASES[record.wallet]);
    link.searchParams.set("dapp_encryption_public_key", record.publicKey);
    link.searchParams.set("redirect_link", redirect.href);
    if (method === "connect") {
      link.searchParams.set("app_url", location.origin + location.pathname);
      link.searchParams.set("cluster", "mainnet-beta");
    } else {
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const encrypted = nacl.box.after(encoder.encode(JSON.stringify(payload)), nonce, decode(record.sharedSecret));
      link.searchParams.set("nonce", encode(nonce));
      link.searchParams.set("payload", encode(encrypted));
    }
    record.pending = { id, method, createdAt: Date.now(), vote };
    write(record); // Must succeed before leaving the browser.
    location.assign(link.href);
  }

  function connect(wallet) {
    requireCrypto();
    if (!Object.hasOwn(BASES, wallet)) throw new Error("WALLET_LINK_INVALID");
    const pair = nacl.box.keyPair();
    request({ wallet, publicKey: encode(pair.publicKey), secretKey: encode(pair.secretKey), expiresAt: Date.now() + SESSION_TTL }, "connect");
  }

  function provider(record) {
    return {
      isDeepLink: true,
      publicKey: record.address,
      connect: async () => ({ publicKey: record.address }),
      disconnect: async () => forget(),
      requestSignature(message, vote) {
        const current = read();
        if (!current || current.address !== record.address || current.publicKey !== record.publicKey || !current.session) {
          throw new Error("WALLET_SESSION_EXPIRED");
        }
        request(current, "signMessage", { message: encode(message), session: current.session, display: "utf8" }, vote);
      },
    };
  }

  function restore() {
    const record = read();
    return record && record.session && record.address ? provider(record) : null;
  }

  function handleCallback() {
    const url = new URL(location.href);
    if (!url.searchParams.has("wallet_callback")) return null;
    const params = new URLSearchParams(url.search);
    // Remove wallet responses from history before processing or issuing API requests.
    for (const key of CALLBACK_PARAMS) url.searchParams.delete(key);
    history.replaceState(null, "", url.href);
    requireCrypto();
    const record = read();
    const pending = record && record.pending;
    if (!pending || pending.id !== params.get("wallet_request") || pending.method !== params.get("wallet_callback")) {
      throw new Error("WALLET_CALLBACK_MISSING");
    }
    delete record.pending;
    write(record); // Consume once, including rejected, expired or invalid responses.
    if (Date.now() - pending.createdAt > REQUEST_TTL) throw new Error("WALLET_REQUEST_EXPIRED");
    if (params.has("errorCode")) throw new Error("WALLET_REQUEST_REJECTED");
    const shared = pending.method === "connect"
      ? nacl.box.before(decode(params.get(`${record.wallet}_encryption_public_key`)), decode(record.secretKey))
      : decode(record.sharedSecret);
    const decrypted = nacl.box.open.after(decode(params.get("data")), decode(params.get("nonce")), shared);
    if (!decrypted) throw new Error("WALLET_LINK_INVALID");
    const response = JSON.parse(decoder.decode(decrypted));
    if (pending.method === "connect") {
      if (decode(response.public_key).length !== 32 || typeof response.session !== "string" || !response.session) throw new Error("WALLET_LINK_INVALID");
      record.address = response.public_key;
      record.session = response.session;
      record.sharedSecret = encode(shared);
      delete record.secretKey;
      write(record);
      return { provider: provider(record) };
    }
    const vote = pending.vote;
    const signature = decode(response.signature);
    if (!vote || vote.wallet !== record.address || signature.length !== 64 || !nacl.sign.detached.verify(encoder.encode(vote.message), signature, decode(record.address))) {
      throw new Error("WALLET_LINK_INVALID");
    }
    return { provider: provider(record), vote: { ...vote, signature: response.signature } };
  }

  window.WalletLinks = { connect, restore, forget, handleCallback };
})();
