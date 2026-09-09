import { ethers } from 'ethers';

// rpcPool.js
//
// Rotates across multiple RPC endpoints (different providers, different
// accounts on the same provider, whatever you have) so hitting one
// endpoint's rate limit or credit cap doesn't stall the bot.
//
// READS auto-retry across the whole list on a transient error - safe, since
// a read has no side effects.
//
// WRITES do NOT auto-retry with a fresh call. If a bet or claim transaction
// actually landed but the response timed out, resending an independently-
// built transaction (fresh nonce) could double-bet or double-claim. A write
// failure still rotates the pointer so the NEXT attempt (next round, next
// claim check) uses a different endpoint - but that retry is the caller's
// own next attempt, not this module resending blindly.

const TRANSIENT_PATTERNS = [
  /rate.?limit/i, /\b429\b/, /quota/i, /credit/i, /time.?out/i,
  /ECONNREFUSED/, /ECONNRESET/, /ENOTFOUND/, /EAI_AGAIN/,
  /network error/i, /failed to fetch/i, /missing response/i, /could not detect network/i,
];
const TRANSIENT_CODES = new Set(['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN_ERROR']);

export function isTransientRpcError(err) {
  if (err?.code && TRANSIENT_CODES.has(err.code)) return true;
  const text = `${err?.message ?? ''}`;
  return TRANSIENT_PATTERNS.some((re) => re.test(text));
}

// Strips query strings / path segments that usually carry API keys, so
// rotation logs never leak a credential.
function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname.length > 1 ? '/…' : ''}`;
  } catch {
    return '(unparseable URL)';
  }
}

export class RpcPool {
  constructor({ urls, privateKey, contractAddress, abi }) {
    if (!urls || !urls.length) throw new Error('RpcPool needs at least one RPC URL');
    this.urls = urls;
    this.privateKey = privateKey;
    this.contractAddress = contractAddress;
    this.abi = abi;
    this.address = new ethers.Wallet(privateKey).address; // fixed - same account regardless of which RPC is active
    this.index = 0;
    this._build();
  }

  _build() {
    const url = this.urls[this.index];
    this.provider = new ethers.JsonRpcProvider(url);
    this.wallet = new ethers.Wallet(this.privateKey, this.provider);
    this.contract = new ethers.Contract(this.contractAddress, this.abi, this.wallet);
    return url;
  }

  get current() {
    return { contract: this.contract, wallet: this.wallet, provider: this.provider, url: this.urls[this.index] };
  }

  rotate() {
    if (this.urls.length === 1) return this.current; // nothing to rotate to
    const prev = this.urls[this.index];
    this.index = (this.index + 1) % this.urls.length;
    const next = this._build();
    console.warn(`[rpcPool] rotating endpoint ${this.index}/${this.urls.length}: ${redact(prev)} -> ${redact(next)}`);
    return this.current;
  }

  /**
   * Read-only call with automatic failover. `fn(contract, provider)` receives
   * the current instances. On a transient error, rotates and retries, up to
   * one full pass through the list, then throws the last error.
   */
  async withReadFailover(fn) {
    let lastErr;
    for (let attempt = 0; attempt < this.urls.length; attempt++) {
      try {
        return await fn(this.contract, this.provider);
      } catch (err) {
        lastErr = err;
        if (!isTransientRpcError(err) || this.urls.length === 1) throw err;
        this.rotate();
      }
    }
    throw lastErr;
  }
}
