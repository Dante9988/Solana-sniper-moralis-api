# Solana Sniper Bot Web Interface

This is the web interface for the Solana Sniper Bot, built with React and Chakra UI.

## Features

- Modern, responsive design
- Integration with Solana wallet
- Real-time token tracking
- Rug check protection
- Take profit and stop loss strategies
- Discord and Telegram notifications

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Solana wallet (Phantom, Solflare, etc.)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/solana-sniper-bot.git
cd solana-sniper-bot/web
```

2. Install dependencies:
```bash
npm install
# or
yarn install
```

3. Create a `.env` file in the `web` directory and add your environment variables:
```env
REACT_APP_DISCORD_INVITE=your_discord_invite
REACT_APP_TELEGRAM_CHANNEL=your_telegram_channel
REACT_APP_MORALIS_API_KEY=your_moralis_api_key
```

## Development

To start the development server:

```bash
npm start
# or
yarn start
```

The application will be available at `http://localhost:3000`.

## Building for Production

To create a production build:

```bash
npm run build
# or
yarn build
```

The build output will be in the `build` directory.

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.
