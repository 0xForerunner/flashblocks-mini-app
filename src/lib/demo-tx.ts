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
import { createNonceManager, jsonRpc } from 'viem/nonce';

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
const worldchainRpcJwtSecret = process.env.WORLDCHAIN_RPC_JWT ?? '';

const base64url = (data: Buffer | string) =>
  Buffer.from(data).toString('base64url');

const signJwt = (secret: string): string => {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: Math.floor(Date.now() / 1000) }),
  );
  const key = Buffer.from(secret.replace(/^0x/, ''), 'hex');
  const signature = crypto
    .createHmac('sha256', key)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
};

const rpcTransportOptions = worldchainRpcJwtSecret
  ? {
      onFetchRequest: (_request: Request, init: RequestInit) => ({
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${signJwt(worldchainRpcJwtSecret)}`,
        },
      }),
    }
  : {};

const spoofTransactions = process.env.DEMO_SPOOF_TRANSACTIONS === 'true';
const SPOOF_CONFIRMATION_DELAY_MS_BY_LANE: Record<DemoLane, number> = {
  flashblocks: 800,
  normal: 2_500,
};
const SPOOF_METHOD_BY_LANE: Record<DemoLane, 'receipt' | 'latest'> = {
  flashblocks: 'receipt',
  normal: 'latest',
};
const NORMAL_BLOCK_TAG = 'latest' as const;

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
  transport: http(worldchainRpcHttp, rpcTransportOptions),
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

const createDemoWalletProvider = (privateKey: Hex) => {
  const nonceManager = createNonceManager({
    source: jsonRpc(),
  });
  const account = privateKeyToAccount(privateKey, { nonceManager });
  const walletClient = createWalletClient({
    account,
    chain: worldchain,
    transport: http(worldchainRpcHttp, rpcTransportOptions),
  });

  return {
    privateKey,
    account,
    walletClient,
    nonceManager,
  };
};

type DemoWalletProvider = ReturnType<typeof createDemoWalletProvider>;

let demoWalletProvider: DemoWalletProvider | null = null;

const getDemoWalletProvider = (): DemoWalletProvider => {
  const privateKey = normalizePrivateKey();
  if (demoWalletProvider?.privateKey === privateKey) {
    return demoWalletProvider;
  }

  demoWalletProvider = createDemoWalletProvider(privateKey);
  return demoWalletProvider;
};

const getDemoAccount = () => getDemoWalletProvider().account;
const getDemoAccountOrNull = () => {
  try {
    return getDemoAccount();
  } catch {
    return null;
  }
};

const getWalletClient = () => getDemoWalletProvider().walletClient;

let sendTransactionQueue: Promise<void> = Promise.resolve();

const enqueueSendTransaction = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = sendTransactionQueue.then(operation, operation);
  sendTransactionQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const isNonceSyncError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('nonce provided for the transaction is lower') ||
    message.includes('nonce too low') ||
    message.includes('already known')
  );
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

  const walletProvider = getDemoWalletProvider();
  const account = walletProvider.account;
  const walletClient = getWalletClient();

  const sendTransaction = () =>
    walletClient.sendTransaction({
      account,
      to: account.address,
      value: BigInt(0),
      gas: BigInt(21_000),
    });

  const txHash = await enqueueSendTransaction(async () => {
    try {
      return await sendTransaction();
    } catch (error) {
      if (!isNonceSyncError(error)) {
        throw error;
      }

      walletProvider.nonceManager.reset({
        address: account.address,
        chainId: worldchain.id,
      });

      return sendTransaction();
    }
  });

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
  method: 'receipt' | 'latest' | 'none';
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
      method: SPOOF_METHOD_BY_LANE[lane],
      blockNumber: null,
    };
  }

  if (lane === 'flashblocks') {
    const receipt = (await publicClient.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    })) as RpcTransactionReceipt | null;

    if (receipt) {
      return {
        confirmed: true,
        method: 'receipt',
        blockNumber:
          receipt.blockNumber !== null && receipt.blockNumber !== undefined
            ? hexToNumber(receipt.blockNumber)
            : null,
      };
    }

    return {
      confirmed: false,
      method: 'none',
      blockNumber: null,
    };
  }

  const block = (await publicClient.request({
    method: 'eth_getBlockByNumber',
    params: [NORMAL_BLOCK_TAG, false],
  })) as RpcPendingBlock | null;

  const inBlock =
    block?.transactions?.some(
      (candidateTxHash) =>
        candidateTxHash.toLowerCase() === txHash.toLowerCase(),
    ) ?? false;

  if (inBlock) {
    return {
      confirmed: true,
      method: 'latest',
      blockNumber:
        block?.number !== null && block?.number !== undefined
          ? hexToNumber(block.number)
          : null,
    };
  }

  return {
    confirmed: false,
    method: 'none',
    blockNumber: null,
  };
};
