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
        
        const prompt = `
You are Strobe AI, a technical analyst. You MUST follow this EXACT format and structure in your response:

Token Data:
${data.ticker} (${data.tokenMint})
💰 Market Cap: ${marketCap}
💧 Liquidity: ${data.liquidity}
👨‍💻 Dev Stats: ${data.holdingBundles}/${data.totalBundles} bundles, ${data.totalSolSpent} SOL spent
🔒 Security: ${data.rugCheckPassed ? 'PASSED' : 'FAILED'}, Bonded: ${data.isBonded ? 'Yes' : 'No'}

📊 MARKET_CAP_LEVELS
Support:
• 💪 Strong: $XXK (recent bounce level, high volume)
• 👍 Medium: $XXK (previous consolidation)
• 📍 Weak: $XXK (recent low)

Resistance:
• 🔥 Strong: $XXK (previous peak, high rejection)
• ⭐ Medium: $XXK (psychological level)
• 📌 Weak: $XXK (recent high)

📐 FIBONACCI_LEVELS
Range: From $XXK (recent low) → To $XXK (recent high)
• 0.236: $XXK
• 0.382: $XXK (key reversal zone)
• 0.500: $XXK
• 0.618: $XXK (golden ratio)
• 0.786: $XXK
📍 Current price is at: [Above/Below] [level] level
🎯 Next key reversal zone: $XXK

🐦 SOCIAL_POSTS
Total Mentions (24h): [number] posts mentioning ${data.ticker} or ${data.tokenMint}

Notable Posts:
• @Username (XXXk followers): "Quote" - https://x.com/username/status/[ID]
(If no verified accounts with 10k+ followers mentioned this token in the last 24h, write exactly: "No significant social mentions found.")

📈 ANALYSIS_SUMMARY
• 👨‍💻 Dev Activity: [one-line analysis]
• 📊 Market Metrics: [one-line analysis]
• 📢 Narrative: [one-line current market narrative/catalyst]
• 🎯 Sentiment: [Bullish/Neutral/Bearish] - [one-line reason based on metrics and social activity]
• ⚡ Key Reversal Zones: [identify closest fib level for potential reversal]

Rules:
1. Use EXACTLY these section titles and emojis
2. Always show the exact price range used for Fibonacci calculation
3. Calculate levels from the most recent significant low to the most recent high
4. Use ${marketCap.includes('K') ? 'K' : marketCap.includes('M') ? 'M' : 'B'} format consistently
5. For Fibonacci, clearly state the price range being used`;

        const response = await axios.post(
            'https://api.x.ai/v1/chat/completions',
            {
                messages: [
                    {
                        role: "system",
                        content: "You are Strobe AI, a crypto analyst. Provide brief, data-driven analysis. Focus on market cap levels, notable social mentions, and key metrics. Be concise and direct."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                model: "grok-2-latest",
                stream: false,
                temperature: 0
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
