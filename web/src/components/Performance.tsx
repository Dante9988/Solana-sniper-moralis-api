import React, { useState } from 'react';
import { FiTrendingUp, FiExternalLink } from 'react-icons/fi';
import { FaDiscord, FaLock } from 'react-icons/fa';

interface TradeCard {
  tokenName: string;
  profit: number;
  percentage: number;
  soldAmount: number;
  discordLink: string;
}

const Performance: React.FC = () => {
  const [showAll, setShowAll] = useState(false);

  const trades: TradeCard[] = [
    { tokenName: 'MEEMEECON', profit: 87608, percentage: 60332.99, soldAmount: 604.3, discordLink: 'https://discord.com/channels/1330060831492276265/1351033758093938750/1354119536819048520' },
    { tokenName: 'BigBalls', profit: 41906, percentage: 29928.94, soldAmount: 300.3, discordLink: 'https://discord.com/channels/1330060831492276265/1351033758093938750/1353923484631306312' },
    { tokenName: 'SPICE', profit: 12486, percentage: 8620.17, soldAmount: 87.2, discordLink: 'https://discord.com/channels/1330060831492276265/1351033758093938750/1354149755206369340' },
    { tokenName: 'ODR', profit: 14619, percentage: 10568.46, soldAmount: 106.7, discordLink: 'https://discord.com/channels/1330060831492276265/1351033758093938750/1353942089121140827' },
    { tokenName: 'SIMP 0136', profit: 8404, percentage: 5791.92, soldAmount: 58.9, discordLink: 'https://discord.com/channels/1330060831492276265/1351033758093938750/1354153523650101280' },
    { tokenName: 'WTTB', profit: 3817, percentage: 2669.03, soldAmount: 27.7, discordLink: 'https://discord.com/channels/1330060831492276265/1351033758093938750/1354217722699059350' },
    { tokenName: 'FUZZY', profit: 1814, percentage: 1249.99, soldAmount: 13.5, discordLink: 'https://discord.com/channels/1330060831492276265/1351033758093938750/1354202617487556758' },
    { tokenName: 'TRUMPCORE', profit: 1110, percentage: 792.68, soldAmount: 8.9, discordLink: 'https://discord.com/channels/1330060831492276265/1351033758093938750/1353922947974430720' },
    { tokenName: 'M1', profit: 541, percentage: 373.62, soldAmount: 4.7, discordLink: 'https://discord.com/channels/1330060831492276265/1351033758093938750/1354161098752004458' },
    { tokenName: 'FIGHT', profit: 647, percentage: 462.17, soldAmount: 5.6, discordLink: 'https://discord.com/channels/1330060831492276265/1351033758093938750/1353923477022707865' },
    { tokenName: 'BREAD', profit: 401, percentage: 276.55, soldAmount: 3.8, discordLink: 'https://discord.com/channels/1330060831492276265/1351033758093938750/1354176188888776954' },
    { tokenName: 'PERUSE', profit: 426, percentage: 293.77, soldAmount: 3.9, discordLink: 'https://discord.com/channels/1330060831492276265/1351033758093938750/1354183755153014946' },

  ];

  const visibleTrades = showAll ? trades : trades.slice(0, 6);
  const totalProfit = trades.reduce((sum, trade) => sum + trade.profit, 0);
  const averageReturn = (trades.reduce((sum, trade) => sum + trade.percentage, 0) / trades.length).toFixed(2);

  return (
    <section className="relative bg-gray-900 text-white py-20 overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 bg-gradient-to-b from-gray-900 via-gray-900 to-primary-900/20" />
      
      {/* Content */}
      <div className="container mx-auto px-4 max-w-7xl relative">
        <div className="text-center mb-12">
          <h2 className="text-4xl lg:text-5xl font-bold bg-gradient-to-r from-primary-400 via-pink-500 to-primary-400 bg-clip-text text-transparent animate-gradient">
            Proven Track Record
          </h2>
          <div className="mt-6 flex flex-wrap justify-center gap-8">
            <div className="bg-gray-800/50 backdrop-blur-sm p-6 rounded-lg border border-gray-700">
              <div className="text-3xl font-bold text-green-400">${totalProfit.toLocaleString()}+</div>
              <div className="text-gray-400">Total Profit Generated</div>
            </div>
            <div className="bg-gray-800/50 backdrop-blur-sm p-6 rounded-lg border border-gray-700">
              <div className="text-3xl font-bold text-green-400">+200%</div>
              <div className="text-gray-400">Average Return per Trade</div>
            </div>
          </div>
          <p className="text-gray-400 mt-6">
            All trades are based on 1 SOL investment. Join our Discord to verify these calls in real-time!
          </p>
        </div>

        {/* Animated Trade Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {visibleTrades.map((trade, index) => (
            <div
              key={trade.tokenName}
              className="relative group transform hover:scale-105 transition-all duration-300"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-primary-500 to-pink-500 rounded-lg blur opacity-25 group-hover:opacity-75 transition duration-500" />
              <div className="relative p-6 bg-gray-800/90 backdrop-blur-sm rounded-lg border border-gray-700 hover:border-primary-500 transition-all duration-300">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-xl font-bold text-white mb-1">${trade.tokenName}</h3>
                    <div className="flex items-center gap-2">
                      <FiTrendingUp className="text-green-400" />
                      <span className="text-green-400">+{trade.percentage.toFixed(2)}%</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-green-400">
                      ${trade.profit.toLocaleString()}
                    </div>
                    <div className="text-sm text-gray-400">
                      {trade.soldAmount} SOL sold
                    </div>
                  </div>
                </div>
                <div className="w-full bg-gray-700 h-1 rounded-full overflow-hidden mb-4">
                  <div 
                    className="bg-gradient-to-r from-primary-500 to-pink-500 h-full animate-expand"
                    style={{ 
                      width: `${Math.min(100, (trade.percentage / 1000) * 100)}%`,
                      transition: `width ${1 + index * 0.2}s ease-out`
                    }}
                  />
                </div>
                <a
                  href={trade.discordLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full py-2 px-4 bg-gray-700/50 hover:bg-gray-700 rounded-lg transition-colors duration-200"
                >
                  <FaDiscord />
                  <span>Verify Call</span>
                  <FiExternalLink className="text-sm" />
                </a>
              </div>
            </div>
          ))}
        </div>

        {/* Show More / Join Discord CTA */}
        <div className="mt-12 text-center">
          {!showAll && (
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-t from-gray-900 to-transparent" />
              <button
                onClick={() => setShowAll(true)}
                className="relative z-10 inline-flex items-center gap-2 px-8 py-4 bg-gradient-to-r from-primary-600 to-pink-600 text-white rounded-lg hover:from-primary-700 hover:to-pink-700 transition-all duration-200 hover:scale-105 group"
              >
                <FaLock className="text-sm group-hover:rotate-12 transition-transform duration-200" />
                <span>Unlock {trades.length - visibleTrades.length} More Trades</span>
              </button>
            </div>
          )}
          
          <a
            href="https://discord.gg/your-invite"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-8 py-4 mt-6 bg-discord hover:bg-discord-dark text-white rounded-lg transition-all duration-200 hover:scale-105"
          >
            <FaDiscord className="text-xl" />
            <span>Join Discord for Live Calls</span>
          </a>
        </div>

        {/* Floating Elements */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-2 h-2 bg-primary-400 rounded-full animate-ping" />
          <div className="absolute bottom-1/4 right-1/4 w-2 h-2 bg-pink-400 rounded-full animate-ping delay-300" />
          <div className="absolute top-3/4 left-3/4 w-2 h-2 bg-green-400 rounded-full animate-ping delay-700" />
        </div>
      </div>
    </section>
  );
};

export default Performance; 