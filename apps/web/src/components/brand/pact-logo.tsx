/** Official Pact Soft Gate geometry from public/brand/pact/svg/pact-logo-horizontal.svg.
 * Keep the whole lockup monochrome, preserve its aspect ratio and clear space.
 */
export function PactLogo({ width = 112, markOnly = false }: { width?: number; markOnly?: boolean }) {
  return (
    <svg
      className="pact-logo"
      width={width}
      height={(width * 256) / (markOnly ? 256 : 832)}
      viewBox={markOnly ? '0 0 256 256' : '0 0 832 256'}
      role="img"
      aria-label="Pact"
      fill="currentColor"
    >
      {[0, 90, 180, 270].map(rotation => (
        <g key={rotation} transform={`rotate(${rotation} 128 128)`}>
          <path
            d="M136 0h32c13.3 0 24 10.7 24 24v72c0 22.1-17.9 40-40 40h-4c-6.6 0-12 5.4-12 12v4c0 22.1-17.9 40-40 40H24c-13.3 0-24-10.7-24-24v-24c0-26.5 21.5-48 48-48h16c17.7 0 32-14.3 32-32V48c0-26.5 17.5-48 40-48Z"
            transform="translate(16 16) scale(.5520833333)"
          />
        </g>
      ))}
      {!markOnly && (
        <g>
          <path
            d="M288 80h72c25.4 0 40 14.6 40 36s-14.6 36-40 36h-44v24h-28V80Zm28 24v24h42c9.1 0 14-4 14-12s-4.9-12-14-12h-42Z"
            fillRule="evenodd"
          />
          <path d="m410 176 45-96h30l45 96h-30l-30-70-30 70h-30Z" />
          <path d="M566 80h92v24h-84c-6.6 0-12 5.4-12 12v24c0 6.6 5.4 12 12 12h84v24h-92c-17.7 0-32-14.3-32-32v-32c0-17.7 14.3-32 32-32Z" />
          <path
            transform="translate(20)"
            d="M674 80h112c6.6 0 12 5.4 12 12v12h-48v72h-28v-72h-60V92c0-6.6 5.4-12 12-12Z"
          />
        </g>
      )}
    </svg>
  );
}
