import React from 'react';
import { FaDiscord, FaTelegram, FaCog, FaRobot, FaCoins, FaChartLine, FaShieldAlt, FaEye } from 'react-icons/fa';
import { HiLightningBolt } from 'react-icons/hi';
import { RiExchangeFundsFill } from 'react-icons/ri';

const CommandCenter: React.FC = () => {
  const discordLink = "https://discord.gg/your-invite-link";
  const telegramLink = "https://t.me/your-telegram-link";

  const configOptions = [
    {
      icon: <FaCoins className="w-5 h-5" />,
      name: "Buy Amount",
      description: "Set custom SOL amount for each trade",
      command: "/config",
      param: "buy_amount",
      value: "1.5"
    },
    {
      icon: <FaChartLine className="w-5 h-5" />,
      name: "Take Profit",
      description: "Auto-sell at your target %",
      command: "/config",
      param: "tp",
      value: "100%"
    },
    {
      icon: <RiExchangeFundsFill className="w-5 h-5" />,
      name: "Partial Sells",
      description: "Configure split sells (50%, custom)",
      command: "/config",
      param: "sell_amount",
      value: "50%"
    },
    {
      icon: <HiLightningBolt className="w-5 h-5" />,
      name: "Stop Loss",
      description: "Set safety nets (-15%, -20%)",
      command: "/config",
      param: "sl",
      value: "-15%"
    }
  ];

  return (
    <section className="relative bg-gray-900 text-white py-20 overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 bg-gradient-to-b from-gray-900 via-gray-900 to-primary-900/20" />
      
      {/* Content */}
      <div className="container mx-auto px-4 max-w-7xl relative">
        <div className="text-center mb-16">
          <h2 className="text-4xl lg:text-5xl font-bold bg-gradient-to-r from-primary-400 via-pink-500 to-primary-400 bg-clip-text text-transparent animate-gradient">
            Command Center
          </h2>
          <p className="text-xl text-gray-300 mt-4 font-medium">
            Your personal trading assistant, available 24/7
          </p>
        </div>

        {/* Platforms */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
          <a 
            href={discordLink}
            target="_blank"
            rel="noopener noreferrer"
            className="relative group"
          >
            <div className="absolute inset-0 bg-[#5865F2]/20 rounded-xl blur-xl group-hover:bg-[#5865F2]/30 transition duration-500" />
            <div className="relative p-8 bg-gray-800/90 backdrop-blur-sm rounded-xl border border-gray-700 hover:border-[#5865F2] transition-all duration-300">
              <div className="flex items-center gap-4">
                <FaDiscord className="w-12 h-12 text-[#5865F2]" />
                <div>
                  <h3 className="text-2xl font-bold mb-2">Discord Bot</h3>
                  <p className="text-lg text-gray-300">Join our Discord community for live calls and instant trades</p>
                </div>
              </div>
            </div>
          </a>

          <a 
            href={telegramLink}
            target="_blank"
            rel="noopener noreferrer"
            className="relative group"
          >
            <div className="absolute inset-0 bg-[#229ED9]/20 rounded-xl blur-xl group-hover:bg-[#229ED9]/30 transition duration-500" />
            <div className="relative p-8 bg-gray-800/90 backdrop-blur-sm rounded-xl border border-gray-700 hover:border-[#229ED9] transition-all duration-300">
              <div className="flex items-center gap-4">
                <FaTelegram className="w-12 h-12 text-[#229ED9]" />
                <div>
                  <h3 className="text-2xl font-bold mb-2">Telegram Bot</h3>
                  <p className="text-lg text-gray-300">Get instant notifications and execute trades on Telegram</p>
                </div>
              </div>
            </div>
          </a>
        </div>

        {/* Configuration Options */}
        <div className="relative">
          <div className="absolute inset-0 bg-gradient-to-r from-primary-500/20 to-pink-500/20 rounded-xl blur-xl" />
          <div className="relative bg-gray-800/90 backdrop-blur-sm rounded-xl border border-gray-700 p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="p-3 bg-primary-500/20 rounded-lg">
                <FaCog className="w-8 h-8 text-primary-400 animate-spin-slow" />
              </div>
              <h3 className="text-2xl font-bold">Smart Configuration</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {configOptions.map((option) => (
                <div 
                  key={option.name}
                  className="group relative bg-gray-800/50 rounded-lg p-6 hover:bg-gray-800 transition-all duration-300 flex flex-col h-[180px]"
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="p-2 bg-primary-500/10 rounded-lg group-hover:bg-primary-500/20 transition-colors duration-300">
                      {option.icon}
                    </div>
                    <h4 className="font-semibold">{option.name}</h4>
                  </div>
                  <p className="text-sm text-gray-300 font-medium">{option.description}</p>
                  <div className="mt-auto">
                    <div className="text-sm bg-[#0B1117] p-3 rounded font-mono text-[#4D9EFF]">
                      {option.command} {option.param} {option.value}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Additional Features */}
            <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-gray-800/50 p-6 rounded-lg border border-gray-700 flex items-center gap-4">
                <div className="p-3 bg-green-500/10 rounded-lg">
                  <FaRobot className="w-7 h-7 text-green-400" />
                </div>
                <div>
                  <h4 className="text-lg font-bold mb-1">Auto-Trading</h4>
                  <p className="text-gray-300">Automatic execution of bot calls</p>
                </div>
              </div>
              <div className="bg-gray-800/50 p-6 rounded-lg border border-gray-700 flex items-center gap-4">
                <div className="p-3 bg-primary-500/10 rounded-lg">
                  <HiLightningBolt className="w-7 h-7 text-primary-400" />
                </div>
                <div>
                  <h4 className="text-lg font-bold mb-1">Jito Integration</h4>
                  <p className="text-gray-300">Fast & cheap transactions</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Floating Elements */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-2 h-2 bg-[#5865F2] rounded-full animate-ping" />
          <div className="absolute bottom-1/4 right-1/4 w-2 h-2 bg-[#229ED9] rounded-full animate-ping delay-300" />
          <div className="absolute top-3/4 left-3/4 w-2 h-2 bg-primary-400 rounded-full animate-ping delay-700" />
        </div>
      </div>
    </section>
  );
};

export default CommandCenter; 