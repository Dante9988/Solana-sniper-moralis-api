import axios from 'axios';

export interface TokenAnalysisData {
    // Market data
    tokenMint: string;
    ticker: string;
    marketCap: string;
    currentPrice: number;
    initialPrice: number;
    liquidity: string;
    volume24h: string;
    totalSupply: number;
    decimals: number;
    priceChangePercentage24h?: number;
    
    // Trench data
    totalBundles: number;
    holdingBundles: number;
    totalSolSpent: string;
    holdingPercentage: string;
    isBonded: boolean;
    
    // Security
    rugCheckPassed: boolean;
    
    // Price history
    priceHistory: Array<{
        unixTime: number;
        value: number;
    }>;
    
    // Sniper data
    sniperData?: {
        totalSnipers: number;
        profitableSnipers: number;
        profitablePercentage: number;
        averageProfitPercentage: number;
        totalSnipedUsd: number;
        totalSoldUsd: number;
        totalProfitUsd: number;
        quickestSellBlocksAfter: number | null;
    };
    
    // Swap data
    swapData?: {
        recentSwaps: number;
        buySwaps: number;
        sellSwaps: number;
        buyRatio: number;
        averageSwapSize: number;
        largestSwap: number;
        uniqueWallets: number;
    };
}

function calculateMarketCap(price: number, supply: number = 1_000_000_000, decimals: number = 9): string {
    // Adjust for token decimals
    const actualSupply = supply / Math.pow(10, decimals);
    const marketCap = price * actualSupply;
    
    if (isNaN(marketCap)) return 'Unknown';
    if (marketCap >= 1e9) return `$${(marketCap / 1e9).toFixed(2)}B`;
    if (marketCap >= 1e6) return `$${(marketCap / 1e6).toFixed(2)}M`;
    if (marketCap >= 1e3) return `$${(marketCap / 1e3).toFixed(2)}K`;
    return `$${marketCap.toFixed(2)}`;
}

export async function analyzeTokenWithGrok(data: TokenAnalysisData): Promise<string> {
    try {
        const marketCap = calculateMarketCap(data.currentPrice, data.totalSupply, data.decimals);
        
        // Calculate price change from initial to current
        const priceChangeFromInitial = data.initialPrice > 0 
            ? ((data.currentPrice - data.initialPrice) / data.initialPrice) * 100 
            : 0;
        
        // Find highest price in history to calculate drop from ATH
        let highestPrice = data.currentPrice;
        let lowestPrice = data.currentPrice;
        
        if (data.priceHistory && data.priceHistory.length > 0) {
            highestPrice = Math.max(...data.priceHistory.map(p => p.value));
            lowestPrice = Math.min(...data.priceHistory.map(p => p.value));
        }
        
        const dropFromATH = highestPrice > 0 
            ? ((data.currentPrice - highestPrice) / highestPrice) * 100 
            : 0;
        
        // Check if token is likely dead (dropped >80% from peak)
        const isProbablyDead = dropFromATH < -80;
        
        // Get the absolute drop percentage as a number
        const absDropPercentage = Math.abs(dropFromATH);
        
        // Determine if we have enough swap data to analyze
        const hasSwapData = data.swapData && data.swapData.recentSwaps > 5;
        
        // Calculate volatility from price history if available
        let volatility = 0;
        if (data.priceHistory && data.priceHistory.length > 1) {
            const prices = data.priceHistory.map(p => p.value);
            const returns = [];
            for (let i = 1; i < prices.length; i++) {
                if (prices[i-1] > 0) {
                    returns.push((prices[i] - prices[i-1]) / prices[i-1]);
                }
            }
            
            if (returns.length > 0) {
                const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
                volatility = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length) * 100;
            }
        }
        
        // Prepare sniper data section
        let sniperSection = '';
        if (data.sniperData && data.sniperData.totalSnipers > 0) {
            sniperSection = `
SNIPER_ACTIVITY
Total Snipers: ${data.sniperData.totalSnipers}
Profitable Snipers: ${data.sniperData.profitableSnipers} (${data.sniperData.profitablePercentage.toFixed(1)}%)
Average Profit: ${data.sniperData.averageProfitPercentage.toFixed(1)}%
Quickest Sell: ${data.sniperData.quickestSellBlocksAfter || 'N/A'} blocks after creation
Total Sniped USD: $${data.sniperData.totalSnipedUsd?.toFixed(2) || 'N/A'}
Total Sold USD: $${data.sniperData.totalSoldUsd?.toFixed(2) || 'N/A'}
Total Profit USD: $${data.sniperData.totalProfitUsd?.toFixed(2) || 'N/A'}`;
        } else {
            sniperSection = `
SNIPER_ACTIVITY
No significant sniper activity detected.`;
        }
        
        // Prepare swap data section
        let swapSection = '';
        if (hasSwapData) {
            swapSection = `
SWAP_ACTIVITY
Recent Swaps: ${data.swapData?.recentSwaps || 0}
Buy Swaps: ${data.swapData?.buySwaps || 0}
Sell Swaps: ${data.swapData?.sellSwaps || 0}
Buy/Sell Ratio: ${(data.swapData?.buyRatio || 0).toFixed(2)}
Average Swap Size: $${(data.swapData?.averageSwapSize || 0).toFixed(2)}
Largest Swap: $${(data.swapData?.largestSwap || 0).toFixed(2)}
Unique Wallets: ${data.swapData?.uniqueWallets || 0}`;
        } else {
            swapSection = `
SWAP_ACTIVITY
Insufficient swap data available.`;
        }
        
        // Prepare prompt for Grok
        const prompt = `Analyze this Solana token:

Token: ${data.ticker} (${data.tokenMint})
Current Price: $${data.currentPrice}
Initial Price: $${data.initialPrice}
All-Time High: $${highestPrice}
All-Time Low: $${lowestPrice}
Drop from ATH: ${dropFromATH.toFixed(2)}%
Market Cap: ${marketCap}
Liquidity: ${data.liquidity}
24h Volume: ${data.volume24h}
Volatility: ${volatility.toFixed(2)}%

Developer Stats:
Bundles: ${data.holdingBundles}/${data.totalBundles}
Holding Percentage: ${data.holdingPercentage}%
Total SOL Spent: ${data.totalSolSpent} SOL
Bonding Curve Complete: ${data.isBonded ? 'Yes' : 'No'}
Rug Check: ${data.rugCheckPassed ? 'PASSED' : 'FAILED'}

${sniperSection}

${swapSection}

Based on this data, provide a brief analysis with the following sections:

${isProbablyDead ? `
You are a degen trencher on Solana looking for the next 100x. This token is down ${absDropPercentage.toFixed(0)}% from ATH.

Be extremely direct and use humor to tell traders this token is dead and they should move on. Don't provide detailed analysis for a dead token - just a brief summary of why it's dead and a funny one-liner about how rekt holders are.

Format your response like this:

💀 DEAD TOKEN ALERT
[One paragraph explaining why this token is dead with humor]

🧟 ANALYSIS_SUMMARY
• 👨‍💻 Dev Activity: [one-line assessment]
• 💰 Market Status: [one-line about how dead it is]
• 🚨 Recommendation: [funny one-liner telling degens to look elsewhere]
` : `
MARKET_CAP_LEVELS
FIBONACCI_LEVELS
SNIPER_ACTIVITY
SWAP_ACTIVITY
SOCIAL_POSTS
ANALYSIS_SUMMARY

Important notes:
1. Be realistic about the token's prospects based on the data.
2. ${hasSwapData ? 'Use the Moralis swap data to determine support and resistance levels.' : 'There is limited swap data, so be cautious about support/resistance levels.'}
3. If the token has very low liquidity, don't pretend it has good support/resistance levels.
4. Use emojis in your analysis to make it more engaging.
5. Format your response exactly like this:

📈 MARKET_CAP_LEVELS
Support:
• 💪 Strong: $X (reason)
• 👍 Medium: $X (reason)
• 📍 Weak: $X (reason)

Resistance:
• 🔥 Strong: $X (reason)
• ⭐ Medium: $X (reason)
• 📌 Weak: $X (reason)

📐 FIBONACCI_LEVELS
Range: From $${lowestPrice} (all-time low) → To $${highestPrice} (all-time high)
• 0.236: $X
• 0.382: $X (key reversal zone)
• 0.500: $X
• 0.618: $X (golden ratio)
• 0.786: $X
📍 Current price is at: [level]
🎯 Next key reversal zone: $X

🤖 SNIPER_ACTIVITY
[sniper analysis with metrics]

💱 SWAP_ACTIVITY
[swap analysis with metrics]

🐦 SOCIAL_POSTS
No verified social posts detected.

📊 ANALYSIS_SUMMARY
• 👨‍💻 Dev Activity: [one-line assessment]
• 📈 Market Metrics: [one-line assessment]
• 📢 Narrative: [one-line current market narrative/catalyst]
• 🎯 Sentiment: [Bullish/Neutral/Bearish] - [one-line reason]
• ⚡ Key Reversal Zones: [identify closest fib level for potential reversal]
• 💰 Buy/Sell Recommendation: [Clear recommendation with price targets]`}`;

        const response = await axios.post(
            'https://api.x.ai/v1/chat/completions',
            {
                messages: [
                    {
                        role: "system",
                        content: "You are Strobe AI, a degen trencher on Solana looking for the next 100x. You're brutally honest, use humor, and don't sugarcoat dead tokens. You talk like a true degen who gambles on Solana memecoins."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                model: "grok-2-latest",
                stream: false,
                temperature: 0.9
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.GROK_API_KEY}`
                }
            }
        );

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('Error analyzing token with Grok:', error);
        return '';
    }
}

export async function updateDiscordWithGrokAnalysis(
    channel: any,
    messageId: string,
    currentEmbed: any,
    grokAnalysis: string
): Promise<void> {
    try {
        // Split analysis into sections of max 1024 chars
        const sections = grokAnalysis.match(/.{1,1000}/g) || [];
        
        const updatedEmbed = {
            ...currentEmbed,
            fields: [
                ...(currentEmbed.fields || []),
                ...sections.map((section, index) => ({
                    name: index === 0 ? '🤖 STROBE AI ANALYSIS' : '📝 Continued...',
                    value: `${index === 0 ? '━━━━━━━━━━━━━━━━━━━━━━\n' : ''}${section}`,
                    inline: false
                }))
            ]
        };

        await channel.messages.edit(messageId, { embeds: [updatedEmbed] });
    } catch (error) {
        console.error('Error updating Discord message with Grok analysis:', error);
    }
}
