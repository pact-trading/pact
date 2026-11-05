'use client';

import { useId, type HTMLAttributes } from 'react';
import {
  IconChevronLeft,
  IconChevronRight,
  IconLayoutSidebar,
  IconShieldHalf,
  IconReload,
  IconShare2,
  IconPlus,
  IconCopy,
  IconLock,
} from '@tabler/icons-react';

// Adapted from the Magic UI Safari reference supplied by the user.
// DOM content stays interactive; only the decorative frame is an SVG overlay.
const WIDTH = 1203;
const HEIGHT = 753;
export interface SafariProps extends HTMLAttributes<HTMLDivElement> {
  url?: string;
  imageSrc?: string;
  videoSrc?: string;
  mode?: 'default' | 'simple';
}
export function Safari({
  imageSrc,
  videoSrc,
  url,
  mode = 'default',
  children,
  className,
  style,
  ...props
}: SafariProps) {
  const punchId = useId();
  const hasContent = !!children || !!videoSrc || !!imageSrc;
  return (
    <div
      className={['device-mockup safari-mockup', className].filter(Boolean).join(' ')}
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: WIDTH + '/' + HEIGHT,
        background: 'var(--card, #fff)',
        borderRadius: '1%',
        ...style,
      }}
      data-device-frame="safari"
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
            left: 100 / WIDTH + '%',
            top: 5200 / HEIGHT + '%',
            width: 120000 / WIDTH + '%',
            height: 70000 / HEIGHT + '%',
            borderRadius: '0 0 11px 11px',
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
                src={imageSrc}
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
        viewBox="0 0 1203 753"
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
        <defs>
          <mask id={punchId} maskUnits="userSpaceOnUse">
            <rect width={WIDTH} height={HEIGHT} fill="white" />
            <path
              d="M1 52H1201V741C1201 747.075 1196.08 752 1190 752H12C5.92486 752 1 747.075 1 741V52Z"
              fill="black"
            />
          </mask>
        </defs>
        <g mask={hasContent ? 'url(#' + punchId + ')' : undefined}>
          <path
            d="M0 52H1202V741C1202 747.627 1196.63 753 1190 753H12C5.37258 753 0 747.627 0 741V52Z"
            fill="var(--border, #e5e5e5)"
          />
          <path
            d="M0 12C0 5.37258 5.37258 0 12 0H1190C1196.63 0 1202 5.37258 1202 12V52H0V12Z"
            fill="var(--border, #e5e5e5)"
          />
          <path
            d="M1.06738 12C1.06738 5.92487 5.99225 1 12.0674 1H1189.93C1196.01 1 1200.93 5.92487 1200.93 12V51H1.06738V12Z"
            className="fill-white dark:fill-[#262626]"
          />
          {[27, 47, 67].map(x => (
            <circle key={x} cx={x} cy="25" r="6" className="fill-[#E5E5E5] dark:fill-[#404040]" />
          ))}
          <rect
            x="286"
            y="11"
            width="666"
            height="30"
            rx="6"
            className="fill-[#E5E5E5] dark:fill-[#404040]"
          />
          {url && (
            <g className="safari-address" style={{ color: '#a3a3a3' }}>
              <g transform="translate(540 18)">
                <IconLock width={14} height={14} />
              </g>
              <text x="562" y="30" fontSize="12" fill="#a3a3a3" fontFamily="var(--font-sans)">
                {url}
              </text>
            </g>
          )}
          {mode === 'default' && (
            <g className="safari-chrome-icons" style={{ color: '#a3a3a3' }}>
              <g transform="translate(97 18)">
                <IconLayoutSidebar width={19} height={16} />
              </g>
              <g transform="translate(135 18)">
                <IconChevronLeft width={16} height={16} />
              </g>
              <g transform="translate(163 18)">
                <IconChevronRight width={16} height={16} />
              </g>
              <g transform="translate(258 18)">
                <IconShieldHalf width={16} height={16} />
              </g>
              <g transform="translate(929 18)">
                <IconReload width={16} height={16} />
              </g>
              <g transform="translate(1091 18)">
                <IconShare2 width={18} height={18} />
              </g>
              <g transform="translate(1126 18)">
                <IconPlus width={16} height={16} />
              </g>
              <g transform="translate(1158 18)">
                <IconCopy width={20} height={18} />
              </g>
            </g>
          )}
        </g>
      </svg>
    </div>
  );
}
