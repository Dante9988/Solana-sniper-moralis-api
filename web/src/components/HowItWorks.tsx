import React from 'react';
import { FaDiscord, FaRobot, FaRocket, FaChartLine } from 'react-icons/fa';
import { HiLightningBolt } from 'react-icons/hi';
import { RiExchangeFill } from 'react-icons/ri';

const HowItWorks: React.FC = () => {
  const steps = [
    {
      icon: <FaDiscord className="w-8 h-8" />,
      title: "Join Discord",
      description: "Connect with our community and get access to the bot",
      level: "Level 1",
      color: "from-[#5865F2] to-[#4752C4]"
    },
    {
      icon: <FaRobot className="w-8 h-8" />,
      title: "Configure Bot",
      description: "Set your trading preferences and risk management",
      level: "Level 2",
      color: "from-emerald-500 to-teal-600"
    },
    {
      icon: <HiLightningBolt className="w-8 h-8" />,
      title: "Auto-Trading",
      description: "Let the bot execute trades based on signals",
      level: "Level 3",
      color: "from-primary-400 to-pink-600"
    },
    {
      icon: <FaChartLine className="w-8 h-8" />,
      title: "Track Profits",
      description: "Monitor your performance and earnings",
      level: "Level 4",
      color: "from-amber-500 to-orange-600"
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
            Start Your Journey
          </h2>
          <p className="text-xl text-gray-300 mt-4 font-medium">
            Level up your trading game in 4 simple steps
          </p>
        </div>

        {/* Steps Journey */}
        <div className="relative">
          {/* Connection Line */}
          <div className="absolute top-1/2 left-0 w-full h-1 bg-gradient-to-r from-[#5865F2] via-emerald-500 to-amber-500 transform -translate-y-1/2 hidden lg:block" />
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {steps.map((step, index) => (
              <div key={step.title} className="relative group">
                {/* Achievement Card */}
                <div className="absolute -top-12 left-1/2 transform -translate-x-1/2 bg-gray-800 px-4 py-2 rounded-full opacity-0 group-hover:opacity-100 transition-all duration-300 whitespace-nowrap">
                  <span className={`text-sm font-bold bg-gradient-to-r ${step.color} bg-clip-text text-transparent`}>
                    {step.level} Unlocked! 🏆
                  </span>
                </div>

                <div className={`relative p-8 bg-gray-800/90 backdrop-blur-sm rounded-xl border border-gray-700 hover:border-transparent transition-all duration-300 group-hover:transform group-hover:scale-105`}>
                  {/* Glowing background */}
                  <div className={`absolute inset-0 bg-gradient-to-r ${step.color} opacity-0 group-hover:opacity-10 rounded-xl transition-opacity duration-300`} />
                  
                  {/* Step Number */}
                  <div className="absolute -top-4 -left-4 w-8 h-8 rounded-full bg-gray-900 border-2 border-gray-700 flex items-center justify-center text-sm font-bold">
                    {index + 1}
                  </div>

                  {/* Content */}
                  <div className="relative">
                    <div className={`p-3 bg-gradient-to-r ${step.color} rounded-lg w-fit mb-4`}>
                      {React.cloneElement(step.icon, { className: "text-white" })}
                    </div>
                    <h3 className="text-xl font-bold mb-2">{step.title}</h3>
                    <p className="text-gray-300">{step.description}</p>
                  </div>

                  {/* Progress Indicator */}
                  <div className="absolute bottom-4 right-4">
                    <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Floating Elements */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-2 h-2 bg-[#5865F2] rounded-full animate-ping" />
          <div className="absolute bottom-1/3 right-1/4 w-2 h-2 bg-emerald-400 rounded-full animate-ping delay-300" />
          <div className="absolute top-2/3 left-2/3 w-2 h-2 bg-amber-400 rounded-full animate-ping delay-700" />
        </div>
      </div>
    </section>
  );
};

export default HowItWorks; 