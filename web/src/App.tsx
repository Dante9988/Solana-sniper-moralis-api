import React from 'react';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import Features from './components/Features';
import HowItWorks from './components/HowItWorks';
import Performance from './components/Performance';
import SniperZones from './components/SniperZones';
import CommandCenter from './components/CommandCenter';
import Footer from './components/Footer';

function App() {
  return (
    <div className="min-h-screen bg-gray-900">
      <Navbar />
      <Hero />
      <Performance />
      <SniperZones />
      <CommandCenter />
      <Features />
      <HowItWorks />
      <Footer />
    </div>
  );
}

export default App;
