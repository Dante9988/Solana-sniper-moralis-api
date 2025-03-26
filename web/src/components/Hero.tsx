import React from 'react';
import { FaDiscord } from 'react-icons/fa';
import moralisLogo from '../partnerLogo/moralis.png';

const Hero: React.FC = () => {
  return (
    <section className="relative bg-gray-900 text-white py-20 overflow-hidden">
      {/* Background gradient and effects */}
      <div className="absolute inset-0 bg-gradient-to-b from-gray-900 via-gray-900 to-primary-900/20" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(17,24,39,0.8),rgba(17,24,39,0.9))]" />
      
      {/* Animated background elements */}
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary-500/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-pink-500/10 rounded-full blur-3xl animate-pulse delay-1000" />
      </div>

      <div className="container mx-auto px-4 max-w-7xl relative">
        <div className="flex flex-col lg:flex-row items-center justify-between">
          <div className="flex-1 mb-10 lg:mb-0">
            <div className="mb-6">
              <h1 className="text-5xl lg:text-6xl font-bold bg-gradient-to-r from-primary-400 via-pink-500 to-primary-400 bg-clip-text text-transparent animate-gradient mb-4">
                Solana AI Sniper Bot
              </h1>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-400">
                  Powered by Moralis API
                </span>
                <img
                  src={moralisLogo}
                  alt="Moralis API"
                  className="h-10"
                />
              </div>
            </div>
            <p className="text-xl mb-8 text-gray-300 leading-relaxed">
              Automated trading bot for Solana tokens with advanced features like rug check protection,
              take profit strategies, and real-time notifications.
            </p>
            <a
              href="https://discord.gg/your-invite"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-6 py-3 bg-gradient-to-r from-primary-600 to-pink-600 text-white rounded-lg hover:from-primary-700 hover:to-pink-700 transition-all duration-200 hover:scale-105 hover:shadow-lg hover:shadow-primary-500/20"
            >
              <FaDiscord className="mr-2" />
              Join Our Community
            </a>
          </div>
          <div className="flex-1 lg:ml-10">
            <div className="relative pt-[56.25%] rounded-xl overflow-hidden bg-gray-800/50 backdrop-blur-sm border border-gray-700 shadow-xl shadow-primary-500/10">
              <iframe
                className="absolute top-0 left-0 w-full h-full"
                src="https://www.youtube.com/embed/your-video-id"
                title="Solana Sniper Bot Demo"
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Hero; 