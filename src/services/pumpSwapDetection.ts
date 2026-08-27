/**
 * Pure, side-effect-free pool/migration-detection constants and helpers used
 * by the Token Intelligence pipeline (src/intelligence/**, tokenIntelligenceDispatch.ts).
 *
 * Deliberately kept separate from src/services/pumpswapService.ts (the
 * trading module used by index.ts and the Telegram bot) — that file
 * constructs a live `Connection` and a `PumpSwapService` instance at module
 * load time (`export const pumpSwapService = new PumpSwapService()`), which
 * crashes on import without a live RPC URl (e.g. in CI/tests). This module
 * has no such side effect and is safe to import anywhere, including tests.
 *
 * Also deliberately NOT named with only a case difference from
 * pumpswapService.ts: the two previously collided on a case-insensitive
 * filesystem, which is what caused this file to go missing in the first
 * place (see the merge-damage fix that restored it).
 */
import { Connection, PublicKey } from '@solana/web3.js';

export const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Raydium Migration Account
export const PUMP_FUN_RAYDIUM_MIGRATION = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');

// Discriminator for CompleteEvent from IDL
export const COMPLETE_EVENT_DISCRIMINATOR = [95, 114, 97, 156, 212, 46, 152, 8];

export interface PoolTokens {
    baseToken: string;
    quoteToken: string;
    lpToken: string;
}

export interface BondingCurveAccount {
    virtualTokenReserves: bigint;
    virtualSolReserves: bigint;
    realTokenReserves: bigint;
    realSolReserves: bigint;
    tokenTotalSupply: bigint;
    complete: boolean;
}

export function isBondingCurveComplete(logs: string[]): boolean {
    // Look for CompleteEvent discriminator or withdraw instruction in the logs
    return logs.some(log => 
        typeof log === "string" && (
            // Check for the event discriminator
            log.includes(COMPLETE_EVENT_DISCRIMINATOR.join(", ")) ||
            // Check for withdraw instruction (used for migration)
            log.includes("Program log: Instruction: Withdraw") ||
            // Also check for the completion message
            log.includes("Program log: Bonding curve complete")
        )
    );
}

export function isPumpSwapPoolCreation(logs: string[]): boolean {
    // Check for Create_pool instruction with Pump.fun AMM and extract WSOL amount
    const liquidityLog = logs.find(log => 
        typeof log === "string" && 
        log.includes("Create_pool") && 
        log.includes("WSOL")
    );

    if (!liquidityLog) return false;

    // Extract WSOL amount from the log
    const wsolMatch = liquidityLog.match(/and ([\d,.]+) WSOL/);
    if (!wsolMatch) return false;

    // Parse WSOL amount and check if it's > 80
    const wsolAmount = parseFloat(wsolMatch[1].replace(/,/g, ''));
    if (isNaN(wsolAmount) || wsolAmount <= 80) return false;

    return true;
}

// Extract token mint from logs
export function getTokenMintFromLogs(logs: string[]): PublicKey | null {
    try {
        // Look for Create_pool instruction
        const liquidityLog = logs.find(log => 
            typeof log === "string" && 
            log.includes("Create_pool") && 
            log.includes("WSOL")
        );

        if (liquidityLog) {
            // Extract token amount and symbol before "and X WSOL"
            const tokenMatch = liquidityLog.match(/Create_pool ([\d,.]+ [A-Z0-9]+)/);
            if (tokenMatch && tokenMatch[1]) {
                // Find a transfer log containing this token amount and symbol
                const transferLog = logs.find(log =>
                    typeof log === "string" && 
                    log.includes("Transfer") &&
                    log.includes(tokenMatch[1])
                );
                if (transferLog) {
                    const mintMatch = transferLog.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
                    if (mintMatch) {
                        return new PublicKey(mintMatch[0]);
                    }
                }
            }
        }

        console.log("Debug: Could not find mint in logs");
        return null;
    } catch (error) {
        console.error('Error extracting token mint:', error);
        return null;
    }
}

// Simplified to just check for pool creation with high WSOL
export function isValidMigration(logs: string[]): boolean {
    return isPumpSwapPoolCreation(logs);
}

export async function getBondingCurveState(connection: Connection, mint: PublicKey): Promise<boolean> {
    try {
        // Derive bonding curve PDA
        const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("bonding-curve"),
                mint.toBuffer()
            ],
            PUMP_FUN_PROGRAM_ID
        );

        // Fetch the bonding curve account
        const account = await connection.getAccountInfo(bondingCurvePDA);
        if (!account) return false;

        // Skip 8 bytes of discriminator
        const complete = account.data[account.data.length - 1] === 1; // complete is the last boolean field
        return complete;

    } catch (error) {
        console.error('Error checking bonding curve state:', error);
        return false;
    }
}

// This should be called after detecting a pool creation
export async function verifyPumpFunMigration(
    connection: Connection, 
    logs: string[],
    mint: PublicKey
): Promise<boolean> {
    // First verify this is a pool creation
    if (!isPumpSwapPoolCreation(logs)) return false;

    // Then check if the token's bonding curve is complete
    const isBondingComplete = await getBondingCurveState(connection, mint);
    return isBondingComplete;
} 
