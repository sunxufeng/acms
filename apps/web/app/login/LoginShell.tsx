'use client';

import { useEffect, useState } from 'react';
import { imageUrl, type HomepageConfig } from '@acms/contracts';

function featureIcon(name: string) {
  const common = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 } as const;
  switch (name) {
    case 'shield':
      return (
        <svg {...common}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    case 'users':
      return (
        <svg {...common}>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case 'layers':
      return (
        <svg {...common}>
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
      );
    case 'lock':
      return (
        <svg {...common}>
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      );
    case 'zap':
      return (
        <svg {...common}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="4" />
        </svg>
      );
  }
}

function bgStyle(color: string, image?: string | null): React.CSSProperties {
  const url = imageUrl(image);
  return {
    backgroundColor: color,
    backgroundImage: url ? `url(${url})` : undefined,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  };
}

interface LoginShellProps {
  config: HomepageConfig;
  preview?: boolean;
}

export default function LoginShell({ config, preview }: LoginShellProps) {
  const [logoError, setLogoError] = useState(false);

  // 已登录用户自动跳转到首页
  useEffect(() => {
    fetch('/api/v1/auth/me', { credentials: 'include' })
      .then((r) => {
        if (r.ok) window.location.href = '/';
      })
      .catch(() => {});
  }, []);

  const shellStyle: React.CSSProperties = {
    fontFamily: config.fontFamily,
    fontSize: config.bodyFontSize,
    minHeight: preview ? undefined : '100dvh',
    height: preview ? '100%' : undefined,
  };

  const firstLetter = config.brandName?.charAt(0).toUpperCase() ?? 'A';

  // 当 logoUrl 改变时重置错误状态，允许重新加载
  useEffect(() => {
    setLogoError(false);
  }, [config.logoUrl]);

  return (
    <div className="login-shell" style={shellStyle}>
      <section
        className="login-left"
        style={{
          ...bgStyle(config.leftBgColor, config.leftBgImage),
          color: config.leftTextColor,
          flex: `1 1 ${config.leftWidth}%`,
        }}
      >
        <div className="left-inner">
          <div className="brand-mark">
            {config.logoUrl && !logoError ? (
              <img
                src={imageUrl(config.logoUrl)}
                alt={config.brandName}
                className="mark-box"
                style={{ objectFit: 'contain', background: 'transparent', padding: 4 }}
                onError={() => setLogoError(true)}
              />
            ) : (
              <span className="mark-box">{firstLetter}</span>
            )}
            <div className="mark-text">
              <strong>{config.brandName}</strong>
              <small>{config.brandSubtitle}</small>
            </div>
          </div>

          <p className="eyebrow">{config.eyebrow}</p>
          <p className="section-label">{config.sectionLabel}</p>

          <h1 className="hero" style={{ fontSize: config.headingFontSize }}>
            {config.heroTitle.split('\n').map((line, i) => (
              <span key={i}>
                {line}
                {i < config.heroTitle.split('\n').length - 1 && <br />}
              </span>
            ))}
          </h1>

          <p className="hero-sub">{config.heroSubtitle}</p>

          <ul className="features">
            {config.features.map((f, idx) => (
              <li key={idx}>
                {featureIcon(f.icon)}
                <div>
                  <strong>{f.title}</strong>
                  <span>{f.desc}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <svg className="geo-line" viewBox="0 0 400 600" fill="none">
          <path d="M280 0 L400 120 L400 350 L200 550" vectorEffect="non-scaling-stroke" />
        </svg>
      </section>

      <section
        className="login-right"
        style={{
          ...bgStyle(config.rightBgColor, config.rightBgImage),
          color: config.rightTextColor,
          flex: `1 1 ${config.rightWidth}%`,
        }}
      >
        <div className="right-inner" style={{ maxWidth: 460 }}>
          <p className="right-label">{config.rightLabel}</p>

          <h2 className="right-head">{config.rightHeading}</h2>

          <p className="right-desc">{config.rightDesc}</p>

          <a className="cta-btn" href="/api/v1/auth/login">
            <span className="cta-arrow">&rarr;</span>
            {config.ctaText}
          </a>

          <a
            href="/student-login"
            style={{
              display: 'block',
              textAlign: 'center',
              marginTop: 14,
              color: 'var(--right-text-color, #8a90a2)',
              fontSize: 'var(--font-sm)',
              textDecoration: 'underline',
              opacity: 0.9,
            }}
          >
            我是学生？用学号 + 姓名登录
          </a>

          <div className="status-block">
            <span className="status-tag">{config.statusTag}</span>
            <p className="status-text">{config.statusText}</p>
          </div>
        </div>
      </section>
    </div>
  );
}
