/** QR codes, drawn on the server so the browser needs no library for them. */

import qrcode from 'qrcode-generator';

/** `text` as a QR code: an SVG document that scales to whatever box it is drawn in. */
export const qrSvg = (text: string): string => {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
};
