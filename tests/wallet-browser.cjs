// Browser integration tests with simulated extensions, wallet apps and API responses.
// Requires Playwright + Chromium; never starts server.js or writes vote data.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const nacl = require('../public/vendor/nacl-fast-1.0.3.min.js');
const BASE = 'https://happydev.fi/torrino.dao.voting/';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encode(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex')), out = '';
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b) break; out = '1' + out; }
  return out;
}
function decode(str) {
  let n = 0n;
  for (const c of str) n = n * 58n + BigInt(alphabet.indexOf(c));
  const bytes = [];
  while (n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
async function scenario(browser, wallet, mobile) {
  const signer = nacl.sign.keyPair(), encryption = nacl.box.keyPair();
  const address = encode(signer.publicKey);
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' } : {});
  const page = await context.newPage();
  const errors = [], submissions = [], walletRequests = [];
  page.on('pageerror', e => errors.push(e.message));
  const proposal = { proposal_id: 'test-1', csv_file_name: 'test.csv', title: 'Test proposal', description: 'Wallet integration test', options: ['YES', 'NO'], status: 'active', start_time: Math.floor(Date.now()/1000)-60, end_time: Math.floor(Date.now()/1000)+3600 };
  let shared;
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.hostname === 'phantom.com' || url.hostname === 'solflare.com') {
      walletRequests.push(url.pathname);
      assert.equal(url.hostname, wallet === 'phantom' ? 'phantom.com' : 'solflare.com');
      const callback = new URL(url.searchParams.get('redirect_link'));
      let response;
      if (url.pathname.endsWith('/connect')) {
        shared = nacl.box.before(decode(url.searchParams.get('dapp_encryption_public_key')), encryption.secretKey);
        callback.searchParams.set(`${wallet}_encryption_public_key`, encode(encryption.publicKey));
        response = { public_key: address, session: 'browser-test' };
      } else {
        const payload = JSON.parse(Buffer.from(nacl.box.open.after(decode(url.searchParams.get('payload')), decode(url.searchParams.get('nonce')), shared)).toString());
        assert.equal(payload.session, 'browser-test');
        response = { signature: encode(nacl.sign.detached(decode(payload.message), signer.secretKey)) };
      }
      const nonce = nacl.randomBytes(24);
      callback.searchParams.set('nonce', encode(nonce));
      callback.searchParams.set('data', encode(nacl.box.after(new TextEncoder().encode(JSON.stringify(response)), nonce, shared)));
      return route.fulfill({ status: 302, headers: { location: callback.href }, body: '' });
    }
    if (url.origin !== new URL(BASE).origin) return route.abort();
    if (url.pathname.includes('/api/')) {
      let body;
      if (url.pathname.endsWith('/proposal')) body = { status: 'active', proposals: [proposal] };
      else if (url.pathname.endsWith('/results')) body = { results: [] };
      else if (url.pathname.endsWith('/wallet-nfts')) body = { gen1_count: 1, gen2_count: 0, voting_power: 0.18, gen1_nfts: [], gen2_nfts: [], proposal_states: [{ proposal_id: 'test-1', gen1_available_count: 1, gen2_available_count: 0, voting_power: 0.18 }] };
      else if (url.pathname.endsWith('/vote')) {
        const vote = req.postDataJSON();
        submissions.push(vote);
        assert.equal(vote.wallet, address);
        assert.equal(vote.proposal_id, 'test-1');
        assert.equal(vote.vote, 'YES');
        assert.match(vote.signed_message, /^Torrino DAO governance vote:proposal:test.csv:proposal_hash:[a-f0-9]{64}:option:YES:wallet:/);
        assert.ok(nacl.sign.detached.verify(new TextEncoder().encode(vote.signed_message), decode(vote.signature), signer.publicKey));
        body = { success: true, voting_power: 0.18 };
      } else throw Error('Unexpected API route');
      return route.fulfill({ json: body });
    }
    const file = url.pathname.slice(new URL(BASE).pathname.length) || 'index.html';
    const filename = path.join(__dirname, '../public', file);
    if (!fs.existsSync(filename)) return route.fulfill({ status: 404, body: '' });
    const contentType = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'image/png';
    return route.fulfill({ contentType, body: fs.readFileSync(filename) });
  });
  if (!mobile) await context.addInitScript(({ address, secret }) => {
    window.selectedWallets = [];
    const provider = name => ({ isPhantom: name === 'phantom', isSolflare: name === 'solflare', publicKey: address,
      async connect() { window.selectedWallets.push(name); return { publicKey: address }; },
      async disconnect() {},
      async signMessage(bytes) { return { signature: window.nacl.sign.detached(bytes, Uint8Array.from(secret)) }; }
    });
    window.phantom = { solana: provider('phantom') };
    window.solflare = provider('solflare');
  }, { address, secret: Array.from(signer.secretKey) });
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await page.locator('#walletPicker').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-wallet]').count(), 2);
  if (mobile && wallet === 'phantom') await page.screenshot({ path: '/tmp/torrino-wallet-picker.png' });
  await page.locator(`[data-wallet="${wallet}"]`).click();
  await page.getByRole('button', { name: 'Disconnect Wallet', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-vote-option="YES"]')?.disabled === false);
  assert.equal(await page.locator('#walletAddress').textContent(), address);
  if (!mobile) assert.deepEqual(await page.evaluate(() => window.selectedWallets), [wallet]);
  await page.locator('[data-vote-option="YES"]').click();
  await page.getByText('Vote for test.csv successfully recorded.', { exact: true }).first().waitFor();
  assert.equal(submissions.length, 1);
  if (mobile) {
    assert.deepEqual(walletRequests, ['/ul/v1/connect', '/ul/v1/signMessage']);
    assert.equal(new URL(page.url()).search, '');
    await page.reload();
    await page.getByRole('button', { name: 'Disconnect Wallet', exact: true }).waitFor();
    assert.equal(submissions.length, 1, 'Reload must not resubmit the vote');
  } else await page.locator('#closeFeedbackModal').click();
  await page.getByRole('button', { name: 'Disconnect Wallet', exact: true }).click();
  assert.equal(await page.locator('#walletAddress').textContent(), 'Not connected');
  assert.equal(await page.evaluate(() => localStorage.getItem('torrino.wallet-link.v1')), null);
  assert.deepEqual(errors, []);
  console.log(`PASS ${wallet}: ${mobile ? 'mobile encrypted round trip' : 'desktop explicit selection'}, signed vote, disconnect`);
  await context.close();
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mobile of [false, true]) for (const wallet of ['phantom', 'solflare']) await scenario(browser, wallet, mobile);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
