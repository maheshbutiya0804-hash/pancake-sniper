import WebSocket from 'ws';

/**
 * Maintains a rolling buffer of recent {price, qty, time} trade ticks from
 * Binance for a given symbol. Pure data source - all decision logic
 * (momentum, volatility, multi-timeframe/cross-asset agreement) lives in
 * signal.js so the exact same code path can be replayed against historical
 * data in backtest.js. Used for both the primary asset (BNB) and, when
 * cross-asset confirmation is enabled, a second instance for BTC.
 */
export class PriceFeed {
  constructor({ symbol = 'bnbusdt', maxBufferSeconds = 300 } = {}) {
    this.symbol = symbol.toLowerCase();
    this.maxBufferSeconds = maxBufferSeconds;
    this.ticks = []; // { price, qty, time }
    this.ws = null;
  }

  connect() {
    const url = `wss://stream.binance.com:9443/ws/${this.symbol}@trade`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log(`[priceFeed:${this.symbol}] connected to Binance trade stream`);
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const price = parseFloat(msg.p);
        const qty = parseFloat(msg.q);
        if (Number.isNaN(price) || Number.isNaN(qty)) return;
        const time = Date.now();
        this.ticks.push({ price, qty, time });
        this._trim(time);
      } catch {
        // ignore malformed messages
      }
    });

    this.ws.on('close', () => {
      console.log(`[priceFeed:${this.symbol}] disconnected, reconnecting in 3s...`);
      setTimeout(() => this.connect(), 3000);
    });

    this.ws.on('error', (err) => {
      console.error(`[priceFeed:${this.symbol}] error:`, err.message);
    });
  }

  _trim(now) {
    const cutoff = now - this.maxBufferSeconds * 1000;
    while (this.ticks.length && this.ticks[0].time < cutoff) {
      this.ticks.shift();
    }
  }

  getTicks() {
    return this.ticks;
  }
}
