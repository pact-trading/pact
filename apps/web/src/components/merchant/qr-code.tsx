import QRCode from 'qrcode';

/** Server-rendered QR code for a hosted payment link. */
export async function QrCode({ value, size = 176 }: { value: string; size?: number }) {
  const svg = await QRCode.toString(value, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#0e1116', light: '#ffffff' },
  });
  return (
    <div
      className="inline-block rounded-2xl bg-white p-3"
      style={{ width: size + 24 }}
      role="img"
      aria-label={`QR code for ${value}`}
    >
      <div className="[&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
