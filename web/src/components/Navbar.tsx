import React from 'react';
import { FaDiscord, FaTelegram } from 'react-icons/fa';
import moralisLogo from '../partnerLogo/moralis.png';
import botLogo from '../partnerLogo/logo.png';

const Navbar: React.FC = () => {
  return (
    <nav className="fixed top-0 left-0 right-0 bg-gray-900/80 backdrop-blur-lg text-white py-4 z-50 border-b border-gray-800">
      <div className="container mx-auto px-4 max-w-7xl">
        <div className="flex justify-between items-center">
          <div className="flex items-center">
            <img
              src={botLogo}
              alt="Strobe AI"
              className="h-12 w-12"
            />
            <div className="ml-4">
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold block bg-gradient-to-r from-primary-400 to-pink-600 bg-clip-text text-transparent">
                  Strobe AI
                </span>
                <div className="h-4 w-px bg-gray-700 mx-2" />
                <span className="text-sm text-gray-400">
                  Moralis API
                </span>
                <img
                  src={moralisLogo}
                  alt="Moralis API"
                  className="h-8"
                />
              </div>
            </div>
          </div>
          <div className="flex gap-6">
            <a
              href="https://discord.gg/your-invite"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center text-gray-400 hover:text-primary-400 transition-all duration-200 hover:scale-105"
            >
              <FaDiscord size={20} />
              <span className="ml-2">Discord</span>
            </a>
            <a
              href="https://t.me/your-channel"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center text-gray-400 hover:text-primary-400 transition-all duration-200 hover:scale-105"
            >
              <FaTelegram size={20} />
              <span className="ml-2">Telegram</span>
            </a>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default Navbar; 