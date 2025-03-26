import React from 'react';
import { FaDiscord, FaTelegram, FaTwitter } from 'react-icons/fa';

const Footer: React.FC = () => {
  const currentYear = new Date().getFullYear();
  
  return (
    <footer className="bg-gray-900 border-t border-gray-800">
      <div className="container mx-auto px-4 py-12">
        {/* Main Footer Content */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          {/* Brand Column */}
          <div className="col-span-1 md:col-span-2">
            <h3 className="text-xl font-bold text-white mb-4">Strobe AI</h3>
            <p className="text-gray-400 mb-4">
              Advanced AI-powered trading bot for the Solana ecosystem
            </p>
            <div className="flex space-x-4">
              <a href="#" className="text-gray-400 hover:text-[#5865F2] transition-colors">
                <FaDiscord className="w-6 h-6" />
              </a>
              <a href="#" className="text-gray-400 hover:text-[#229ED9] transition-colors">
                <FaTelegram className="w-6 h-6" />
              </a>
              <a href="#" className="text-gray-400 hover:text-[#1DA1F2] transition-colors">
                <FaTwitter className="w-6 h-6" />
              </a>
            </div>
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="text-white font-semibold mb-4">Quick Links</h4>
            <ul className="space-y-2">
              <li>
                <a href="#" className="text-gray-400 hover:text-white transition-colors">
                  Documentation
                </a>
              </li>
              <li>
                <a href="#" className="text-gray-400 hover:text-white transition-colors">
                  Support
                </a>
              </li>
              <li>
                <a href="#" className="text-gray-400 hover:text-white transition-colors">
                  Community
                </a>
              </li>
            </ul>
          </div>

          {/* Legal Links */}
          <div>
            <h4 className="text-white font-semibold mb-4">Legal</h4>
            <ul className="space-y-2">
              <li>
                <a href="#" className="text-gray-400 hover:text-white transition-colors">
                  Terms of Service
                </a>
              </li>
              <li>
                <a href="#" className="text-gray-400 hover:text-white transition-colors">
                  Privacy Policy
                </a>
              </li>
              <li>
                <a href="#" className="text-gray-400 hover:text-white transition-colors">
                  Risk Disclosure
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="pt-8 border-t border-gray-800">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <div className="text-gray-400 text-sm mb-4 md:mb-0">
              © {currentYear} Strobe AI. All rights reserved.
            </div>
            <div className="text-sm text-gray-500">
              Powered by Grok 3 Technology
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer; 