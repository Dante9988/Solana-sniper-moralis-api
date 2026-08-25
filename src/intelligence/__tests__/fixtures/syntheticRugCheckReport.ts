import { RugResponseExtended } from "../../../types";

export const cleanRugCheckReport: RugResponseExtended = {
  mint: "SynthMint1111111111111111111111111111pump",
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  creator: "SynthCreator11111111111111111111111111111",
  token: {
    mintAuthority: null,
    supply: 1_000_000_000,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: null,
  },
  token_extensions: null,
  tokenMeta: {
    name: "Synthetic Token",
    symbol: "SYNTH",
    uri: "https://example.com/metadata.json",
    mutable: false,
    updateAuthority: "SynthCreator11111111111111111111111111111",
  },
  topHolders: [
    {
      address: "Holder1",
      amount: 50_000_000,
      decimals: 6,
      pct: 5,
      uiAmount: 50_000_000,
      uiAmountString: "50000000",
      owner: "Holder1",
      insider: false,
    },
  ],
  freezeAuthority: null,
  mintAuthority: null,
  risks: [],
  score: 10,
  fileMeta: { description: "" },
} as unknown as RugResponseExtended;

export const ruggedRugCheckReport: RugResponseExtended = {
  ...cleanRugCheckReport,
  mint: "SynthMintRugged2222222222222222222222pump",
  token: {
    mintAuthority: "SomeMintAuthority",
    supply: 1_000_000_000,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: "SomeFreezeAuthority",
  },
  tokenMeta: {
    ...cleanRugCheckReport.tokenMeta,
    mutable: true,
  },
  topHolders: [
    {
      address: "WhaleHolder",
      amount: 400_000_000,
      decimals: 6,
      pct: 40,
      uiAmount: 400_000_000,
      uiAmountString: "400000000",
      owner: "WhaleHolder",
      insider: true,
    },
  ],
  risks: [
    { name: "High concentration", value: "40%", description: "Top holder owns 40% of supply", score: 80, level: "danger" },
  ],
  score: 90,
  rugged: true,
} as unknown as RugResponseExtended;
