/**
 * Phase 7E.1 §9 — route selection.
 *
 * Today exactly one verified route exists per token, because the Pons factory's graduation
 * phase decides it: an ungraduated launch trades on its curve and a graduated one trades in
 * its V4 pool, and the two are never simultaneously live. So selection is a lookup, and §9
 * says explicitly not to build a smart router before there is anything to route between.
 *
 * The shape is still a list rather than an if/else, because the moment a second venue can
 * serve the same token the comparison belongs here — expected output net of gas and fees,
 * not a lifecycle label.
 */

import type { PonsQuote } from "../quote/quoteService";
import { RobinhoodPonsExecutionVenue } from "./ponsCurveVenue";
import { RobinhoodUniswapV4ExecutionVenue } from "./uniswapV4Venue";
import type { ExecutionVenueId, SpotExecutionVenue } from "./venue";

export const EXECUTION_VENUES: readonly SpotExecutionVenue[] = Object.freeze([
  new RobinhoodPonsExecutionVenue(),
  new RobinhoodUniswapV4ExecutionVenue(),
]);

export type RouteSelection =
  | { status: "SELECTED"; venue: SpotExecutionVenue }
  | { status: "NO_ROUTE"; detail: string }
  | { status: "AMBIGUOUS"; detail: string; candidates: ExecutionVenueId[] };

/**
 * Pick the venue for a quote.
 *
 * Two venues claiming the same quote would mean the quote carries contradictory evidence,
 * so it is refused rather than resolved by ordering. §7: show trading as unavailable
 * rather than guess.
 */
export function selectRoute(quote: PonsQuote, venues: readonly SpotExecutionVenue[] = EXECUTION_VENUES): RouteSelection {
  const matches = venues.filter((venue) => venue.supports(quote));
  if (matches.length === 1) return { status: "SELECTED", venue: matches[0] };
  if (matches.length === 0) {
    return { status: "NO_ROUTE", detail: `no execution venue supports a ${quote.venue} quote` };
  }
  return {
    status: "AMBIGUOUS",
    detail: "more than one venue claims this quote, so the routing evidence is inconsistent",
    candidates: matches.map((venue) => venue.id),
  };
}

export function venueById(id: ExecutionVenueId, venues: readonly SpotExecutionVenue[] = EXECUTION_VENUES): SpotExecutionVenue | null {
  return venues.find((venue) => venue.id === id) ?? null;
}
