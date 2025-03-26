import React from 'react';
import { FaRobot, FaChartLine, FaBrain, FaTwitter, FaSearchDollar, FaBolt, FaShieldAlt, FaCrosshairs } from 'react-icons/fa';
import { HiLightningBolt } from 'react-icons/hi';
import { RiExchangeFill, RiRobot2Line } from 'react-icons/ri';

const Features: React.FC = () => {
  const mainFeatures = [
    {
      title: "Strobe AI Agent (Grok 3)",
      description: "Advanced AI-powered analysis and trading assistant",
      icon: <RiRobot2Line className="w-6 h-6" />,
      powerLevel: 98,
      abilities: [
        "X (Twitter) Sentiment Analysis",
        "Fibonacci Level Predictions",
        "Token Narrative Analysis",
        "AI-Driven Market Insights"
      ],
      color: "from-violet-500 to-purple-600"
    },
    {
      title: "PumpFun Integration",
      description: "Exclusive access to PumpFun token ecosystem",
      icon: <FaBolt className="w-6 h-6" />,
      powerLevel: 95,
      abilities: [
        "Token Migration Detection",
        "PumpSwap Integration",
        "Automated Trading",
        "Real-time Monitoring"
      ],
      color: "from-primary-400 to-pink-600"
    },
    {
      title: "Smart Trading System",
      description: "Customizable trading strategies with risk management",
      icon: <FaChartLine className="w-6 h-6" />,
      powerLevel: 92,
      abilities: [
        "Auto Buy/Sell",
        "Custom Take Profit",
        "Stop Loss Protection",
        "Split Sell Strategy"
      ],
      color: "from-emerald-500 to-teal-600"
    }
  ];

  const subFeatures = [
    {
      title: "Crypto Twitter Analysis",
      description: "Real-time monitoring of influential crypto voices",
      icon: <FaTwitter />,
      color: "from-blue-400 to-sky-500"
    },
    {
      title: "Technical Analysis",
      description: "Advanced Fibonacci levels and chart patterns",
      icon: <FaChartLine />,
      color: "from-amber-500 to-orange-600"
    },
    {
      title: "AI Market Sentiment",
      description: "Grok 3-powered market sentiment analysis",
      icon: <FaBrain />,
      color: "from-violet-500 to-purple-600"
    },
    {
      title: "Sniper Precision",
      description: "Lightning-fast execution with Jito integration",
      icon: <FaCrosshairs />,
      color: "from-red-500 to-rose-600"
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
            Powered by Advanced AI
          </h2>
          <p className="text-xl text-gray-300 mt-4 font-medium">
            Unleash the power of Strobe AI Agent with Grok 3 technology
          </p>
        </div>

        {/* Main Features */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-16">
          {mainFeatures.map((feature, index) => (
            <div key={feature.title} className="relative group">
              {/* Power Level Indicator */}
              <div className="absolute -top-3 -right-3 w-16 h-16 bg-gray-800 rounded-full border-2 border-gray-700 flex items-center justify-center z-10 overflow-hidden">
                <div className="text-sm font-bold relative z-10">PWR {feature.powerLevel}</div>
                <div 
                  className={`absolute bottom-0 left-0 w-full bg-gradient-to-t ${feature.color} transition-all duration-500`} 
                  style={{ height: `${feature.powerLevel}%`, opacity: 0.7 }}
                />
              </div>

              <div className={`relative p-8 bg-gray-800/90 backdrop-blur-sm rounded-xl border border-gray-700 hover:border-transparent transition-all duration-300 group-hover:transform group-hover:scale-[1.02] h-full`}>
                {/* Glowing background */}
                <div className={`absolute inset-0 bg-gradient-to-r ${feature.color} opacity-0 group-hover:opacity-10 rounded-xl transition-opacity duration-300`} />

                {/* Content */}
                <div className="relative">
                  <div className={`p-3 bg-gradient-to-r ${feature.color} rounded-lg w-fit mb-4`}>
                    {React.cloneElement(feature.icon, { className: "w-8 h-8 text-white" })}
                  </div>
                  <h3 className="text-2xl font-bold mb-4">{feature.title}</h3>
                  <p className="text-gray-300 mb-6">{feature.description}</p>
                  
                  {/* Abilities */}
                  <div className="space-y-3">
                    {feature.abilities.map((ability, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <div className={`w-1.5 h-1.5 rounded-full bg-gradient-to-r ${feature.color}`} />
                        <span className="text-gray-300">{ability}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Status Indicator */}
                <div className="absolute bottom-4 right-4">
                  <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Sub Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {subFeatures.map((feature, index) => (
            <div key={feature.title} className="relative group">
              <div className={`relative p-6 bg-gray-800/90 backdrop-blur-sm rounded-xl border border-gray-700 hover:border-transparent transition-all duration-300 group-hover:transform group-hover:scale-105`}>
                {/* Glowing background */}
                <div className={`absolute inset-0 bg-gradient-to-r ${feature.color} opacity-0 group-hover:opacity-10 rounded-xl transition-opacity duration-300`} />
                
                <div className="relative">
                  <div className={`p-2 bg-gradient-to-r ${feature.color} rounded-lg w-fit mb-3`}>
                    {React.cloneElement(feature.icon, { className: "w-5 h-5 text-white" })}
                  </div>
                  <h3 className="text-lg font-bold mb-2">{feature.title}</h3>
                  <p className="text-sm text-gray-300">{feature.description}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Floating Elements */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-2 h-2 bg-violet-400 rounded-full animate-ping" />
          <div className="absolute bottom-1/3 right-1/4 w-2 h-2 bg-primary-400 rounded-full animate-ping delay-300" />
          <div className="absolute top-2/3 left-2/3 w-2 h-2 bg-emerald-400 rounded-full animate-ping delay-700" />
        </div>
      </div>
    </section>
  );
};

export default Features; 