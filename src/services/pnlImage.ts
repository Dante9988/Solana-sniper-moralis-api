import { createCanvas } from 'canvas';

import { getSolPrice } from '../utils/tokenUtils';

/**
 * Shared PnL card renderer.
 *
 * This is the single source of truth for the PnL image that gets shared to Discord,
 * Telegram and the OnlyPump UI. It previously existed as two byte-identical 136-line
 * copies (src/pnl-check.ts and src/services/tokenTrackingService.ts), which meant any
 * visual change had to be made twice and could silently drift between the standalone
 * `yarn pnl` script and the live tracker.
 *
 * Renders a 1200x675 card (OG-image aspect ratio, so it previews correctly when a
 * shared link is unfurled by Discord/Telegram/X).
 */

export async function createPnLImage(data: {
  pnlPercentage: number;
  tokenSymbol: string;
  initialMarketCap: number;
  currentMarketCap: number;
  initialSol: number;
  returnedSol: number;
}): Promise<Buffer> {
  try {
    console.log('Creating PnL Image with data:', {
        pnlPercentage: data.pnlPercentage,
        tokenSymbol: data.tokenSymbol,
        initialMarketCap: data.initialMarketCap,
        currentMarketCap: data.currentMarketCap,
        initialSol: data.initialSol,
        returnedSol: data.returnedSol
    });

    const canvas = createCanvas(1200, 675);
    const ctx = canvas.getContext('2d');

    // Create dark purple-black background gradient - fullscreen
    const baseGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    baseGradient.addColorStop(0, '#1a0b2e');
    baseGradient.addColorStop(1, '#0d0517');
    ctx.fillStyle = baseGradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw diamond pattern overlay for subtle texture
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    const gridSize = 30;
    for (let i = 0; i < canvas.width; i += gridSize) {
      for (let j = 0; j < canvas.height; j += gridSize) {
        // Create a diamond pattern
        ctx.beginPath();
        ctx.moveTo(i, j - gridSize/2);
        ctx.lineTo(i + gridSize/2, j);
        ctx.lineTo(i, j + gridSize/2);
        ctx.lineTo(i - gridSize/2, j);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Add subtle glow effect
    const glowGradient = ctx.createRadialGradient(
      canvas.width * 0.3, canvas.height * 0.4, 0,
      canvas.width * 0.3, canvas.height * 0.4, 600
    );
    glowGradient.addColorStop(0, 'rgba(145, 70, 255, 0.15)');
    glowGradient.addColorStop(1, 'rgba(25, 10, 45, 0)');
    ctx.fillStyle = glowGradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Left margin for all text elements
    const leftMargin = 120;

    // Draw token symbol - left aligned instead of centered
    ctx.font = 'bold 70px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('$' + data.tokenSymbol, leftMargin, 120);
    
    // Draw "CURRENT PROFIT" label - left aligned
    ctx.font = '24px Arial';
    ctx.fillStyle = '#9B9B9B';
    ctx.fillText('CURRENT PROFIT', leftMargin, 220);
    
    // Calculate profit value and format it
    const solPrice = await getSolPrice();
    const profitAmount = (data.returnedSol - data.initialSol) * solPrice;
    const formattedProfit = profitAmount >= 0 
      ? `$${Math.abs(Math.round(profitAmount))}` 
      : `$-${Math.abs(Math.round(profitAmount))}`;
    
    // Draw profit amount - larger and left aligned
    // Use green for positive, red for negative
    ctx.font = 'bold 100px Arial'; // Bigger font size
    ctx.fillStyle = profitAmount >= 0 ? '#4CAF50' : '#F44336';
    ctx.fillText(formattedProfit, leftMargin, 250);
    
    // Draw PNL percentage - left aligned
    ctx.font = 'bold 40px Arial'; // Slightly bigger
    ctx.fillStyle = profitAmount >= 0 ? '#4CAF50' : '#F44336';
    ctx.fillText(`+${data.pnlPercentage.toFixed(2)}%`, leftMargin, 360);
    
    // Create section for bought/hold/sold values - spaced horizontally
    const columnWidth = 300; // Width between columns
    const labelY = 450;
    const valueY = 490;
    
    // TOTAL BOUGHT - left aligned
    ctx.font = '22px Arial';
    ctx.fillStyle = '#9B9B9B';
    ctx.fillText('TOTAL BOUGHT', leftMargin, labelY);
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`${data.initialSol.toFixed(1)} SOL`, leftMargin, valueY);
    
    // TOTAL HOLD - in the middle
    ctx.font = '22px Arial';
    ctx.fillStyle = '#9B9B9B';
    ctx.fillText('TOTAL HOLD', leftMargin + columnWidth, labelY);
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('0 SOL', leftMargin + columnWidth, valueY);
    
    // TOTAL SOLD - on the right
    ctx.font = '22px Arial';
    ctx.fillStyle = '#9B9B9B';
    ctx.fillText('TOTAL SOLD', leftMargin + 2*columnWidth, labelY);
    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`${data.returnedSol.toFixed(1)} SOL`, leftMargin + 2*columnWidth, valueY);
    
    // Draw "Powered by Moralis" text at bottom left
    ctx.font = '20px Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillText('Powered by Moralis', leftMargin, canvas.height - 60);
    
    // Draw STROBE branding in bottom right
    ctx.textAlign = 'right';
    ctx.font = 'bold 40px Arial';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('STROBE', canvas.width - 80, canvas.height - 60);
    
    // Reset text alignment for future drawing operations
    ctx.textAlign = 'left';
    
    // Convert canvas to buffer
    return canvas.toBuffer('image/png');
  } catch (error) {
    console.error('Error creating PnL image:', error);
    throw error;
  }
}
