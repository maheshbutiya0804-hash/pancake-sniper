import { ethers } from 'ethers';

// Minimal ABI for the functions/reads this bot needs.
// IMPORTANT: this is written from the well-known PancakeSwap Prediction
// contract pattern. Verify it against the verified source on BscScan for
// your CONTRACT_ADDRESS before trusting it with real funds - a mismatched
// ABI can fail silently or behave unexpectedly.
export const PREDICTION_ABI = [
  'function currentEpoch() view returns (uint256)',
  'function minBetAmount() view returns (uint256)',
  'function paused() view returns (bool)',
  'function rounds(uint256) view returns (uint256 epoch, uint256 startTimestamp, uint256 lockTimestamp, uint256 closeTimestamp, int256 lockPrice, int256 closePrice, uint256 lockOracleId, uint256 closeOracleId, uint256 totalAmount, uint256 bullAmount, uint256 bearAmount, uint256 rewardBaseCalAmount, uint256 rewardAmount, bool oracleCalled)',
  'function betBull(uint256 epoch) payable',
  'function betBear(uint256 epoch) payable',
  'function ledger(uint256 epoch, address user) view returns (uint8 position, uint256 amount, bool claimed)',
  'function claimable(uint256 epoch, address user) view returns (bool)',
  'function claim(uint256[] epochs)',
  'function treasuryFee() view returns (uint256)',
];

export function getContract({ rpcUrl, privateKey, contractAddress }) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, PREDICTION_ABI, wallet);
  return { provider, wallet, contract };
}

export async function getCurrentRound(contract) {
  const epoch = await contract.currentEpoch();
  const round = await contract.rounds(epoch);
  return {
    epoch,
    startTimestamp: Number(round.startTimestamp),
    lockTimestamp: Number(round.lockTimestamp),
    closeTimestamp: Number(round.closeTimestamp),
    bullAmount: round.bullAmount,
    bearAmount: round.bearAmount,
    totalAmount: round.totalAmount,
  };
}
