'use client';

import { useId, type HTMLAttributes } from 'react';

// Magic UI iPhone geometry with a thinner 12px bezel requested for this playground.
const WIDTH = 433;
const HEIGHT = 882;
const SCREEN_X = 12;
const SCREEN_Y = 12;
const SCREEN_WIDTH = 409;
const SCREEN_HEIGHT = 858;
const SCREEN_RADIUS = 63;
export interface IphoneProps extends HTMLAttributes<HTMLDivElement> {
  src?: string;
  videoSrc?: string;
}
export function Iphone({ src, videoSrc, children, className, style, ...props }: IphoneProps) {
  const punchId = useId();
  const hasContent = !!children || !!videoSrc || !!src;
  return (
    <div
      className={['device-mockup iphone-mockup', className].filter(Boolean).join(' ')}
      style={{ position: 'relative', width: '100%', aspectRatio: WIDTH + '/' + HEIGHT, ...style }}
      data-device-frame="iphone"
      {...props}
    >
      {hasContent && (
        <div
          data-device-screen
          className="device-screen"
          style={{
            background: 'var(--card)',
            overscrollBehavior: 'contain',
            position: 'absolute',
            left: (SCREEN_X / WIDTH) * 100 + '%',
            top: (SCREEN_Y / HEIGHT) * 100 + '%',
            width: (SCREEN_WIDTH / WIDTH) * 100 + '%',
            height: (SCREEN_HEIGHT / HEIGHT) * 100 + '%',
            boxShadow: '0 0 0 1px var(--card, #fff)',
            borderRadius:
              (SCREEN_RADIUS / SCREEN_WIDTH) * 100 + '% / ' + (SCREEN_RADIUS / SCREEN_HEIGHT) * 100 + '%',
            overflow: 'auto',
          }}
        >
          {children ||
            (videoSrc ? (
              <video
                src={videoSrc}
                autoPlay
                loop
                muted
                playsInline
                preload="metadata"
                style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <img
                src={src}
                alt=""
                style={{
                  display: 'block',
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  objectPosition: 'top',
                }}
              />
            ))}
        </div>
      )}
      <svg
        viewBox="0 0 433 882"
        fill="none"
        aria-hidden="true"
        className="device-frame-svg"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          transform: 'translateZ(0)',
          zIndex: 2,
        }}
      >
        <g mask={hasContent ? 'url(#' + punchId + ')' : undefined}>
          <path
            d="M2 73C2 32.6832 34.6832 0 75 0H357C397.317 0 430 32.6832 430 73V809C430 849.317 397.317 882 357 882H75C34.6832 882 2 849.317 2 809V73Z"
            className="fill-[#E5E5E5] dark:fill-[#404040]"
          />
          <path
            d="M0 171C0 170.448 0.447715 170 1 170H3V204H1C0.447715 204 0 203.552 0 203V171Z"
            className="fill-[#E5E5E5] dark:fill-[#404040]"
          />
          <path
            d="M1 234C1 233.448 1.44772 233 2 233H3.5V300H2C1.44772 300 1 299.552 1 299V234Z"
            className="fill-[#E5E5E5] dark:fill-[#404040]"
          />
          <path
            d="M1 319C1 318.448 1.44772 318 2 318H3.5V385H2C1.44772 385 1 384.552 1 384V319Z"
            className="fill-[#E5E5E5] dark:fill-[#404040]"
          />
          <path
            d="M430 279H432C432.552 279 433 279.448 433 280V384C433 384.552 432.552 385 432 385H430V279Z"
            className="fill-[#E5E5E5] dark:fill-[#404040]"
          />
          <path
            d="M6 74C6 35.3401 37.3401 4 76 4H356C394.66 4 426 35.3401 426 74V808C426 846.66 394.66 878 356 878H76C37.3401 878 6 846.66 6 808V74Z"
            className="fill-white dark:fill-[#262626]"
          />
        </g>
        <path
          opacity=".5"
          d="M174 5H258V5.5C258 6.60457 257.105 7.5 256 7.5H176C174.895 7.5 174 6.60457 174 5.5V5Z"
          className="fill-[#E5E5E5] dark:fill-[#404040]"
        />
        <rect
          x={SCREEN_X}
          y={SCREEN_Y}
          width={SCREEN_WIDTH}
          height={SCREEN_HEIGHT}
          rx={SCREEN_RADIUS}
          ry={SCREEN_RADIUS}
          className="fill-[#E5E5E5] dark:fill-[#404040]"
          mask={hasContent ? 'url(#' + punchId + ')' : undefined}
        />
        <path
          d="M154 48.5C154 38.2827 162.283 30 172.5 30H259.5C269.717 30 278 38.2827 278 48.5C278 58.7173 269.717 67 259.5 67H172.5C162.283 67 154 58.7173 154 48.5Z"
          className="fill-[#F5F5F5] dark:fill-[#262626]"
        />
        <circle cx="259.5" cy="48.5" r="10.5" className="fill-[#F5F5F5] dark:fill-[#262626]" />
        <circle cx="259.5" cy="48.5" r="5.5" className="fill-[#E5E5E5] dark:fill-[#404040]" />
        <defs>
          <mask id={punchId} maskUnits="userSpaceOnUse">
            <rect width={WIDTH} height={HEIGHT} fill="white" />
            <rect
              x={SCREEN_X}
              y={SCREEN_Y}
              width={SCREEN_WIDTH}
              height={SCREEN_HEIGHT}
              rx={SCREEN_RADIUS}
              ry={SCREEN_RADIUS}
              fill="black"
            />
          </mask>
        </defs>
      </svg>
    </div>
  );
}
