import React from 'react';
import { FaShieldAlt, FaRobot, FaChartLine, FaExchangeAlt } from 'react-icons/fa';
import { HiLightningBolt } from 'react-icons/hi';
import PumpFunLogo from '../partnerLogo/pumpfunlogo.png';

const SniperZones: React.FC = () => {
  return (
    <section className="relative bg-gray-900 text-white py-20 overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 bg-gradient-to-b from-gray-900 via-gray-900 to-primary-900/20" />
      
      {/* Content */}
      <div className="container mx-auto px-4 max-w-7xl relative">
        <div className="text-center mb-16">
          <h2 className="text-4xl lg:text-5xl font-bold bg-gradient-to-r from-primary-400 via-pink-500 to-primary-400 bg-clip-text text-transparent animate-gradient">
            AI-Powered Sniper Intelligence
          </h2>
          <p className="text-gray-400 mt-5">
            The smartest trading bot in the Solana ecosystem
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Main Sniping Zone */}
          <div className="relative group">
            <div className="absolute inset-0 bg-gradient-to-r from-primary-500 to-pink-500 rounded-xl blur opacity-25 group-hover:opacity-75 transition duration-500" />
            <div className="relative p-8 bg-gray-800/90 backdrop-blur-sm rounded-xl border border-gray-700">
              <div className="flex items-center gap-4 mb-6">
                <div className="p-3 bg-primary-500/20 rounded-lg">
                  <HiLightningBolt className="w-8 h-8 text-primary-400" />
                </div>
                <h3 className="text-2xl font-bold">PumpSwap Detection</h3>
              </div>
              
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-primary-500/10 rounded-lg mt-1">
                    <FaExchangeAlt className="w-4 h-4 text-primary-400" />
                  </div>
                  <div>
                    <h4 className="font-semibold mb-1">Migration Scanner</h4>
                    <p className="text-gray-400 text-sm">Instant detection of PumpFun tokens migrating to PumpSwap</p>
                  </div>
                </div>
                
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-green-500/10 rounded-lg mt-1">
                    <FaChartLine className="w-4 h-4 text-green-400" />
                  </div>
                  <div>
                    <h4 className="font-semibold mb-1">Surge Detection</h4>
                    <p className="text-gray-400 text-sm">Monitors PumpFun tokens gaining traction pre-migration</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Security Features */}
          <div className="relative group">
            <div className="absolute inset-0 bg-gradient-to-r from-primary-500 to-pink-500 rounded-xl blur opacity-25 group-hover:opacity-75 transition duration-500" />
            <div className="relative p-8 bg-gray-800/90 backdrop-blur-sm rounded-xl border border-gray-700">
              <div className="flex items-center gap-4 mb-6">
                <div className="p-3 bg-green-500/20 rounded-lg">
                  <FaShieldAlt className="w-8 h-8 text-green-400" />
                </div>
                <h3 className="text-2xl font-bold">Security Measures</h3>
              </div>
              
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-green-500/10 rounded-lg mt-1">
                    <FaRobot className="w-4 h-4 text-green-400" />
                  </div>
                  <div>
                    <h4 className="font-semibold mb-1">Internal Rug Check</h4>
                    <p className="text-gray-400 text-sm">Advanced algorithm to detect and avoid potential rug pulls</p>
                  </div>
                </div>
                
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-primary-500/10 rounded-lg mt-1">
                    <FaChartLine className="w-4 h-4 text-primary-400" />
                  </div>
                  <div>
                    <h4 className="font-semibold mb-1">Token Metrics Analysis</h4>
                    <p className="text-gray-400 text-sm">Real-time evaluation of token health and potential</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Animated Elements */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/3 left-1/4 w-2 h-2 bg-primary-400 rounded-full animate-ping" />
          <div className="absolute bottom-1/3 right-1/4 w-2 h-2 bg-green-400 rounded-full animate-ping delay-300" />
          <div className="absolute top-2/3 left-2/3 w-2 h-2 bg-pink-400 rounded-full animate-ping delay-700" />
        </div>

        {/* Bottom Stats */}
        <div className="mt-12 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-gray-800/50 backdrop-blur-sm p-4 rounded-lg border border-gray-700 text-center group hover:border-primary-500 transition-colors duration-300">
            <div className="flex items-center gap-3 justify-center">
              <img src={PumpFunLogo} alt="PumpSwap" className="w-8 h-8" />
              <div>
                <div className="text-xl font-bold text-[#4D9EFF] group-hover:scale-110 transition-transform duration-300">PumpSwap</div>
                <div className="text-sm text-gray-400">Primary AMM</div>
              </div>
            </div>
          </div>
          <div className="bg-gray-800/50 backdrop-blur-sm p-4 rounded-lg border border-gray-700 text-center group hover:border-primary-500 transition-colors duration-300">
            <div className="flex items-center gap-3 justify-center">
              <img src={PumpFunLogo} alt="PumpFun" className="w-8 h-8" />
              <div>
                <div className="text-xl font-bold text-[#4D9EFF] group-hover:scale-110 transition-transform duration-300">PumpFun</div>
                <div className="text-sm text-gray-400">Token Source</div>
              </div>
            </div>
          </div>
          <div className="bg-gray-800/50 backdrop-blur-sm p-4 rounded-lg border border-gray-700 text-center group hover:border-primary-500 transition-colors duration-300">
            <div className="text-2xl font-bold text-green-400 group-hover:scale-110 transition-transform duration-300">100%</div>
            <div className="text-sm text-gray-400">Rug Protection</div>
          </div>
          <div className="bg-gray-800/50 backdrop-blur-sm p-4 rounded-lg border border-gray-700 text-center group hover:border-primary-500 transition-colors duration-300">
            <div className="text-2xl font-bold text-green-400 group-hover:scale-110 transition-transform duration-300">24/7</div>
            <div className="text-sm text-gray-400">Monitoring</div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default SniperZones; 