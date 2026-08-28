import QRCode from 'qrcode';

/** Renders a Solana Pay URL (or any string) as a PNG buffer for sending as a chat photo. */
export async function renderQrPng(data: string): Promise<Buffer> {
  return QRCode.toBuffer(data, { type: 'png', width: 400, margin: 2 });
}
