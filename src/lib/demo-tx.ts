import crypto from 'crypto';
import {
  Hex,
  createPublicClient,
  createWalletClient,
  formatEther,
  hexToNumber,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { worldchain } from 'viem/chains';

export type DemoLane = 'flashblocks' | 'normal';

type RpcPendingBlock = {
  number: Hex | null;
  transactions: Hex[];
};

type RpcTransactionReceipt = {
  blockNumber: Hex | null;
};

const DEMO_PRIVATE_KEY_ENV = 'DEMO_PRIVATE_KEY';
const LEGACY_FLASHBLOCKS_PRIVATE_KEY_ENV = 'DEMO_FLASHBLOCKS_PRIVATE_KEY';
const LEGACY_NORMAL_PRIVATE_KEY_ENV = 'DEMO_NORMAL_PRIVATE_KEY';

const worldchainRpcHttp =
  process.env.WORLDCHAIN_RPC_HTTP ?? 'https://worldchain.worldcoin.org';

const flashblocksBlockTag =
  process.env.FLASHBLOCKS_BLOCK_TAG === 'latest' ? 'latest' : 'pending';
const spoofTransactions = process.env.DEMO_SPOOF_TRANSACTIONS === 'true';
const SPOOF_CONFIRMATION_DELAY_MS_BY_LANE: Record<DemoLane, number> = {
  flashblocks: 800,
  normal: 2_500,
};

const SPOOF_FROM_BY_LANE: Record<DemoLane, Hex> = {
  flashblocks: '0x00000000000000000000000000000000000000F1',
  normal: '0x00000000000000000000000000000000000000F2',
};

const SPOOF_LANE_CODE: Record<DemoLane, string> = {
  flashblocks: 'f1',
  normal: 'f2',
};

const publicClient = createPublicClient({
  chain: worldchain,
  transport: http(worldchainRpcHttp),
});

const resolvePrivateKeyFromEnv = (): { envName: string; value: string } => {
  const preferred = process.env[DEMO_PRIVATE_KEY_ENV];
  if (preferred) {
    return { envName: DEMO_PRIVATE_KEY_ENV, value: preferred };
  }

  const legacyFlashblocks = process.env[LEGACY_FLASHBLOCKS_PRIVATE_KEY_ENV];
  if (legacyFlashblocks) {
    return {
      envName: LEGACY_FLASHBLOCKS_PRIVATE_KEY_ENV,
      value: legacyFlashblocks,
    };
  }

  const legacyNormal = process.env[LEGACY_NORMAL_PRIVATE_KEY_ENV];
  if (legacyNormal) {
    return {
      envName: LEGACY_NORMAL_PRIVATE_KEY_ENV,
      value: legacyNormal,
    };
  }

  throw new Error(`Missing required env var: ${DEMO_PRIVATE_KEY_ENV}`);
};

const normalizePrivateKey = (): Hex => {
  const { envName, value } = resolvePrivateKeyFromEnv();

  const normalized = value.startsWith('0x')
    ? value
    : `0x${value}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`Invalid private key format for ${envName}`);
  }

  return normalized as Hex;
};

const getDemoAccount = () => privateKeyToAccount(normalizePrivateKey());
const getDemoAccountOrNull = () => {
  try {
    return getDemoAccount();
  } catch {
    return null;
  }
};

const getWalletClient = () => {
  const account = getDemoAccount();

  return createWalletClient({
    account,
    chain: worldchain,
    transport: http(worldchainRpcHttp),
  });
};

let sendTransactionQueue: Promise<void> = Promise.resolve();

const enqueueSendTransaction = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = sendTransactionQueue.then(operation, operation);
  sendTransactionQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const getTransactionReceipt = async (txHash: Hex) => {
  return publicClient.request({
    method: 'eth_getTransactionReceipt',
    params: [txHash],
  }) as Promise<RpcTransactionReceipt | null>;
};

const buildSpoofTxHash = (lane: DemoLane, createdAtMs: number): Hex => {
  const laneCode = SPOOF_LANE_CODE[lane];
  const timestampHex = Math.floor(createdAtMs)
    .toString(16)
    .padStart(12, '0')
    .slice(-12);
  const randomHex = crypto.randomBytes(25).toString('hex');
  return `0x${laneCode}${timestampHex}${randomHex}` as Hex;
};

const parseSpoofTxHash = (
  txHash: Hex,
): {
  lane: DemoLane;
  createdAtMs: number;
} | null => {
  const raw = txHash.slice(2).toLowerCase();
  const laneCode = raw.slice(0, 2);
  const timestampHex = raw.slice(2, 14);

  const lane =
    laneCode === 'f1'
      ? 'flashblocks'
      : laneCode === 'f2'
        ? 'normal'
        : null;

  if (!lane) {
    return null;
  }

  const createdAtMs = Number.parseInt(timestampHex, 16);
  if (!Number.isFinite(createdAtMs)) {
    return null;
  }

  return {
    lane,
    createdAtMs,
  };
};

export const isDemoLane = (value: unknown): value is DemoLane =>
  value === 'flashblocks' || value === 'normal';

export const getDemoWalletSnapshot = async (): Promise<{
  address: Hex | null;
  balanceWei: string | null;
  balanceEth: string | null;
  spoofMode: boolean;
  available: boolean;
}> => {
  const account = getDemoAccountOrNull();

  if (!account) {
    return {
      address: null,
      balanceWei: null,
      balanceEth: null,
      spoofMode: spoofTransactions,
      available: false,
    };
  }

  const balanceWei = await publicClient.getBalance({ address: account.address });
  return {
    address: account.address,
    balanceWei: balanceWei.toString(),
    balanceEth: formatEther(balanceWei),
    spoofMode: spoofTransactions,
    available: true,
  };
};

export const sendLaneTransaction = async (lane: DemoLane) => {
  if (spoofTransactions) {
    const txHash = buildSpoofTxHash(lane, Date.now());

    return {
      txHash,
      from: SPOOF_FROM_BY_LANE[lane],
    };
  }

  const account = getDemoAccount();
  const walletClient = getWalletClient();

  const txHash = await enqueueSendTransaction(() =>
    walletClient.sendTransaction({
      account,
      to: account.address,
      value: BigInt(0),
      gas: BigInt(21_000),
    }),
  );

  return {
    txHash,
    from: account.address,
  };
};

export const checkLaneConfirmation = async (
  lane: DemoLane,
  txHash: Hex,
): Promise<{
  confirmed: boolean;
  method: 'pending' | 'latest' | 'receipt' | 'none';
  blockNumber: number | null;
}> => {
  if (spoofTransactions) {
    const spoofTx = parseSpoofTxHash(txHash);
    if (!spoofTx || spoofTx.lane !== lane) {
      return {
        confirmed: false,
        method: 'none',
        blockNumber: null,
      };
    }

    if (
      Date.now() - spoofTx.createdAtMs <
      SPOOF_CONFIRMATION_DELAY_MS_BY_LANE[lane]
    ) {
      return {
        confirmed: false,
        method: 'none',
        blockNumber: null,
      };
    }

    return {
      confirmed: true,
      method: lane === 'flashblocks' ? flashblocksBlockTag : 'receipt',
      blockNumber: null,
    };
  }

  if (lane === 'flashblocks') {
    const pendingBlock = (await publicClient.request({
      method: 'eth_getBlockByNumber',
      params: [flashblocksBlockTag, false],
    })) as RpcPendingBlock | null;

    const inPendingBlock =
      pendingBlock?.transactions?.some(
        (pendingTxHash) =>
          pendingTxHash.toLowerCase() === txHash.toLowerCase(),
      ) ?? false;

    if (inPendingBlock) {
      return {
        confirmed: true,
        method: flashblocksBlockTag,
        blockNumber:
          pendingBlock?.number !== null && pendingBlock?.number !== undefined
            ? hexToNumber(pendingBlock.number)
            : null,
      };
    }
  }

  const receipt = await getTransactionReceipt(txHash);
  if (receipt?.blockNumber) {
    return {
      confirmed: true,
      method: 'receipt',
      blockNumber: hexToNumber(receipt.blockNumber),
    };
  }

  return {
    confirmed: false,
    method: 'none',
    blockNumber: null,
  };
};
