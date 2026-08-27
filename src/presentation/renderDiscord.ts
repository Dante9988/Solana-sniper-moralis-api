/**
 * Phase 6 — Discord embed renderer (phase6.txt §2.2).
 *
 * Pure function: `RiskView -> EmbedBuilder`. Builds and returns an embed; it
 * never sends it. Does NOT import `src/discord/discord.ts` (that module logs
 * in a client at import time — denylisted for Phase 6, see
 * `src/presentation/__tests__/executionBoundary.test.ts`). `discord.js`
 * itself is just a library and is fine to use here.
 */

import { EmbedBuilder } from "discord.js";
import { PROHIBITED_PATTERNS } from "../intelligence/providers/anthropicSynthesisProvider";
import { RiskView, Severity, Signal, SignalStatus, Verdict } from "./riskView";

const VERDICT_COLOR: Record<Verdict, number> = {
  EXCLUDED: 0x8b0000, // dark red
  HIGH_RISK: 0xe74c3c, // red
  ELEVATED: 0xe67e22, // orange
  UNVERIFIED: 0x95a5a6, // grey
};

const STATUS_ICON: Record<SignalStatus, string> = {
  CONFIRMED: "🔺",
  CLEAR: "✅",
  UNVERIFIED: "⚪",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
  NONE: "NONE",
};

function containsProhibitedLanguage(text: string): boolean {
  return PROHIBITED_PATTERNS.some((pattern) => pattern.test(text));
}

function signalFieldValue(signal: Signal): string {
  if (signal.status === "UNVERIFIED") return signal.unverifiedReason ?? "unavailable";
  const suffix = signal.status === "CONFIRMED" ? ` (${SEVERITY_LABEL[signal.severity]})` : "";
  const evidence =
    signal.evidence.length > 0
      ? `\nEvidence: ${signal.evidence.slice(0, 3).map((e) => `${e.kind.toLowerCase()}:${e.value}`).join(", ")}`
      : "";
  return `${signal.headline}${suffix}${evidence}`;
}

/** Builds (never sends) a Discord embed for one `RiskView`. */
export function renderDiscord(view: RiskView): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Risk verdict: ${view.verdict}`)
    .setColor(VERDICT_COLOR[view.verdict])
    .setDescription(`Mint: \`${view.mint}\`\nPolicy: ${view.policyVersion}`)
    .addFields(
      view.signals.map((signal) => ({
        name: `${STATUS_ICON[signal.status]} ${signal.key}`,
        value: signalFieldValue(signal),
        inline: false,
      }))
    )
    .setFooter({
      text: 'Research only - not financial advice. This system can prove a token is dangerous; it cannot prove one is safe.',
    })
    .setTimestamp(view.generatedAt);

  if (view.synthesis && !containsProhibitedLanguage(view.synthesis.text)) {
    embed.addFields({ name: "AI synthesis (RESEARCH_ONLY)", value: view.synthesis.text.slice(0, 1024) });
  }

  return embed;
}
