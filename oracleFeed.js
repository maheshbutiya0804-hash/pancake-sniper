import { ethers } from 'ethers';

// oracleFeed.js
//
// Polls the SAME Chainlink BNB/USD aggregator PancakeSwap's contract uses
// internally - not to replace the Binance feed, but to track the one gap
// that actually matters: how far live Binance price has drifted from the
// oracle's last posted value. Chainlink updates on a deviation-threshold-or-
// heartbeat basis (this feed's threshold is 0.1%), NOT continuously, and
// PancakeSwap's own docs note it can take up to ~20s to update - so this is
// far too sparse to compute momentum from the way priceFeed.js does. What it
// IS good for: since the oracle lags Binance, a large live gap is a real
// signal that the oracle is about to catch up toward Binance's price.
//
// Verified BNB/USD Chainlink feed on BSC mainnet, cross-checked against
// BscScan, Chainlink's own feed directory, and BNB Chain's official docs:
// 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE

const AGGREGATOR_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
];

export class OracleFeed {
  constructor({ rpcPool, aggregatorAddress, pollIntervalMs = 3000 }) {
    this.rpcPool = rpcPool;
    this.aggregatorAddress = aggregatorAddress;
    this.pollIntervalMs = pollIntervalMs;
    this.decimals = null;
    this.latestPrice = null;
    this.latestUpdatedAt = null; // ms epoch
    this.timer = null;
  }

  async start() {
    await this._poll(); // get one reading immediately, don't wait for the first interval
    this.timer = setInterval(() => {
      this._poll().catch((err) => console.error('[oracleFeed] poll error:', err.message));
    }, this.pollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async _poll() {
    const { answer, updatedAt, decimals } = await this.rpcPool.withReadFailover(async (_predictionContract, provider) => {
      const aggregator = new ethers.Contract(this.aggregatorAddress, AGGREGATOR_ABI, provider);
      const [dec, roundData] = await Promise.all([
        this.decimals != null ? Promise.resolve(this.decimals) : aggregator.decimals(),
        aggregator.latestRoundData(),
      ]);
      return { answer: roundData.answer, updatedAt: Number(roundData.updatedAt), decimals: dec };
    });
    if (this.decimals == null) this.decimals = decimals;
    this.latestPrice = Number(answer) / 10 ** Number(this.decimals);
    this.latestUpdatedAt = updatedAt * 1000;
  }

  /**
   * % gap between a live reference price (e.g. the current Binance tick) and
   * the oracle's last posted value. Positive = reference is ABOVE the oracle
   * (expect the oracle to catch up UP). Negative = reference is BELOW
   * (expect it to catch down). Returns null if no reading yet.
   */
  divergencePct(referencePrice) {
    if (this.latestPrice == null || referencePrice == null) return null;
    return ((referencePrice - this.latestPrice) / this.latestPrice) * 100;
  }

  secondsSinceUpdate() {
    if (this.latestUpdatedAt == null) return null;
    return (Date.now() - this.latestUpdatedAt) / 1000;
  }
}
