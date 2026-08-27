import { MarketObservation, ResearchAssetObservation } from "./types";

const NUMERIC_FIELDS = [
  "priceUsd", "estimatedBuyPriceUsd", "estimatedSellPriceUsd", "liquidityUsd",
  "marketCapUsd", "fdvUsd", "volume24hUsd",
] as const;

export class ObservationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationValidationError";
  }
}

export function validateResearchObservation(observation: ResearchAssetObservation): void {
  if ((observation.type as string) === "POSITION") throw new ObservationValidationError("POSITION is not a research observation");
  if (!observation.observationKey.trim()) throw new ObservationValidationError("observationKey is required");
  if (!observation.source.trim()) throw new ObservationValidationError("source is required");
  if (!(observation.observedAt instanceof Date) || !Number.isFinite(observation.observedAt.getTime())) {
    throw new ObservationValidationError("observedAt must be a valid Date");
  }
  for (const field of NUMERIC_FIELDS) {
    const value = observation[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new ObservationValidationError(`${field} must be finite and non-negative when supplied`);
    }
  }
}

export function createMarketObservation(input: Omit<MarketObservation, "type">): MarketObservation {
  const observation: MarketObservation = { ...input, type: "MARKET" };
  validateResearchObservation(observation);
  return observation;
}
