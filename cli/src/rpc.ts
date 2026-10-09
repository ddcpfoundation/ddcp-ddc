// Thin RPC factory. No network calls are made here — the client is lazy
// until a request is sent.

import { createSolanaRpc } from "@solana/kit";

export type SolanaRpc = ReturnType<typeof createSolanaRpc>;

export function createRpc(rpcUrl: string): SolanaRpc {
  return createSolanaRpc(rpcUrl);
}
