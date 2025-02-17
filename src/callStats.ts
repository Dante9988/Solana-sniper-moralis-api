import { Client, TextChannel, EmbedBuilder, Message, MessageReaction } from 'discord.js';

type MultiplierKey = '2x' | '3x' | '5x' | '10x' | '25x' | '50x' | '100x' | 'poop';

type MultiplierStats = {
    [key in MultiplierKey]: number;
};

interface CallStatistics extends MultiplierStats {
    total: number;
    '2x': number;
    '3x': number;
    '5x': number;
    '10x': number;
    '25x': number;
    '50x': number;
    '100x': number;
    'poop': number;
    'stoploss': number;
}

export class CallStatsAnalyzer {
    private readonly channel: TextChannel;

    constructor(channel: TextChannel) {
        this.channel = channel;
    }

    async getStatistics(daysBack: number = 30): Promise<CallStatistics> {
        const stats: CallStatistics = {
            total: 0,
            '2x': 0,
            '3x': 0,
            '5x': 0,
            '10x': 0,
            '25x': 0,
            '50x': 0,
            '100x': 0,
            'poop': 0,
            'stoploss': 0
        };

        try {
            const threshold = new Date();
            threshold.setDate(threshold.getDate() - daysBack);

            const messages = await this.channel.messages.fetch({ limit: 100 });
            
            const botCalls = messages.filter((msg: Message) => 
                msg.author.bot && 
                msg.content.includes('NEW TOKEN DETECTED') &&
                msg.createdAt >= threshold
            );

            stats.total = botCalls.size;

            for (const message of botCalls.values()) {
                const reactions = message.reactions.cache;
                let hasPerformanceReaction = false;
                
                reactions.forEach((reaction: MessageReaction) => {
                    const emojiName = reaction.emoji.name?.toLowerCase() as MultiplierKey | undefined;
                    if (emojiName) {
                        if (emojiName === 'poop') {
                            stats[emojiName]++;
                            hasPerformanceReaction = true;
                        } else if (emojiName in stats) {
                            stats[emojiName]++;
                            hasPerformanceReaction = true;
                        }
                    }
                });

                // If no performance reaction was found, count as a bad call
                if (!hasPerformanceReaction) {
                    stats['poop']++;
                }
            }

            return stats;
        } catch (error) {
            console.error('Error fetching call statistics:', error);
            throw new Error(error instanceof Error ? error.message : 'Unknown error occurred');
        }
    }

    createStatsEmbed(stats: CallStatistics): EmbedBuilder {
        const successfulCalls = Object.entries(stats)
            .filter(([key]) => !['total', 'poop', 'stoploss'].includes(key))
            .reduce((sum, [_, value]) => sum + value, 0);

        const stopLossCalls = stats.stoploss;
        const ruggedCalls = stats.poop;
        const totalCalls = stats.total;
        
        // Calculate rates
        const profitRate = ((successfulCalls / totalCalls) * 100).toFixed(2);
        const stopLossRate = ((stopLossCalls / totalCalls) * 100).toFixed(2);
        const rugRate = ((ruggedCalls / totalCalls) * 100).toFixed(2);

        // Calculate potential profits with different investment amounts
        const potentialProfit0_1 = this.calculatePotentialProfit(stats, 0.1);
        const potentialProfit0_5 = this.calculatePotentialProfit(stats, 0.5);
        const potentialProfit1_0 = this.calculatePotentialProfit(stats, 1.0);

        return new EmbedBuilder()
            .setTitle('📊 Call Statistics (Last 30 Days)')
            .setColor(0x00FF00)
            .addFields(
                {
                    name: '📈 Performance Breakdown',
                    value: [
                        `• Total Calls: ${stats.total}`,
                        `• 2x: ${stats['2x']} calls`,
                        `• 3x: ${stats['3x']} calls`,
                        `• 5x: ${stats['5x']} calls`,
                        `• 10x: ${stats['10x']} calls`,
                        `• 25x: ${stats['25x']} calls`,
                        `• 50x: ${stats['50x']} calls`,
                        `• 100x: ${stats['100x']} calls`,
                        `• 🛑 Stop Loss (-40%): ${stats.stoploss} calls`,
                        `• 💩 Rugged (-100%): ${stats.poop} calls`
                    ].join('\n')
                },
                {
                    name: '📊 Performance Rates',
                    value: [
                        `✅ Profit Rate: ${profitRate}%`,
                        `⚠️ Stop Loss Rate: ${stopLossRate}%`,
                        `❌ Rug Rate: ${rugRate}%`
                    ].join('\n')
                },
                {
                    name: '💰 Potential Profits (if you followed all calls)',
                    value: [
                        `• With 0.1 SOL per trade: ${potentialProfit0_1.toFixed(2)} SOL`,
                        `• With 0.5 SOL per trade: ${potentialProfit0_5.toFixed(2)} SOL`,
                        `• With 1.0 SOL per trade: ${potentialProfit1_0.toFixed(2)} SOL`,
                    ].join('\n')
                }
            )
            .setFooter({ text: `🕒 Stats updated at: ${this.getEasternTime()} ET` });
    }

    calculatePotentialProfit(stats: CallStatistics, initialInvestment: number = 0.1): number {
        // Calculate profits
        const profits = {
            '2x': (initialInvestment * 1) * stats['2x'],      // 100% profit per trade
            '3x': (initialInvestment * 2) * stats['3x'],      // 200% profit per trade
            '5x': (initialInvestment * 4) * stats['5x'],      // 400% profit per trade
            '10x': (initialInvestment * 9) * stats['10x'],    // 900% profit per trade
            '25x': (initialInvestment * 24) * stats['25x'],   // 2400% profit per trade
            '50x': (initialInvestment * 49) * stats['50x'],   // 4900% profit per trade
            '100x': (initialInvestment * 99) * stats['100x'], // 9900% profit per trade
        };

        // Calculate losses
        const stopLossLoss = (initialInvestment * 0.4) * stats.stoploss;  // 40% loss per stop loss
        const ruggedLoss = initialInvestment * stats.poop;                 // 100% loss per rug

        // Sum up all profits and subtract losses
        const totalProfit = Object.values(profits).reduce((sum, profit) => sum + profit, 0);
        const totalLoss = stopLossLoss + ruggedLoss;
        
        return totalProfit - totalLoss;
    }

    getEasternTime(): string {
        const easternTime = new Date().toLocaleString('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
        return easternTime;
    }
}
