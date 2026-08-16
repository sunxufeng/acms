'use client';

import { useEffect } from 'react';

/* ------------------------------------------------------------------ */
/*  Design tokens (derived from reference: ARETE split-screen auth)    */
/*  Palette: deep forest teal left / darker right / gold accent /     */
/*  mint CTA / white text                                              */
/* ------------------------------------------------------------------ */

export default function LoginPage() {
  useEffect(() => {
    // If already authenticated, redirect to dashboard
    fetch('/api/v1/auth/me', { credentials: 'include' })
      .then((r) => {
        if (r.ok) window.location.href = '/';
      })
      .catch(() => {});
  }, []);

  return (
    <div className="login-shell">
      {/* ── Left panel : brand statement ── */}
      <section className="login-left">
        <div className="left-inner">
          {/* Logo mark */}
          <div className="brand-mark">
            <span className="mark-box">A</span>
            <div className="mark-text">
              <strong>ARETE</strong>
              <small>COLLEGE MGMT</small>
            </div>
          </div>

          {/* Breadcrumb */}
          <p className="eyebrow">AUTH / 01</p>

          {/* Section label */}
          <p className="section-label">IDENTITY GATEWAY</p>

          {/* Hero */}
          <h1 className="hero">
            学院运营
            <br />
            从可信身份开始。
          </h1>

          <p className="hero-sub">
            身份、角色、校区和数据密级在进入工作台前完成校验。浏览器不会直接访问飞书
            Base。
          </p>

          {/* Feature items */}
          <ul className="features">
            <li>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2a10 10 0 1010 10A10 10 0 0012 2zm0 4a6 6 0 11-6 6 6 6 0 016-6z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <div>
                <strong>身份来源</strong>
                <span>Feishu Open ID</span>
              </div>
            </li>
            <li>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <div>
                <strong>授权模型</strong>
                <span>RBAC + ABAC</span>
              </div>
            </li>
            <li>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
              <div>
                <strong>合规边界</strong>
                <span>HttpOnly / S·H</span>
              </div>
            </li>
          </ul>
        </div>

        {/* Geometric decoration */}
        <svg className="geo-line" viewBox="0 0 400 600" fill="none">
          <path d="M280 0 L400 120 L400 350 L200 550" vectorEffect="non-scaling-stroke" />
        </svg>
      </section>

      {/* ── Right panel : action ── */}
      <section className="login-right">
        <div className="right-inner">
          <p className="right-label">SECURE SIGN-IN / ARETE</p>

          <h2 className="right-head">进入管理工作台</h2>

          <p className="right-desc">
            飞书身份必须在「系统用户与角色表」中唯一、启用且处于有效期内；数据范围规则只会收敛角色权限。
          </p>

          <a
            className="cta-btn"
            href="/api/v1/auth/login"
          >
            <span className="cta-arrow">&rarr;</span>
            使用飞书登录
          </a>

          <div className="status-block">
            <span className="status-tag">FAIL. CLOSED</span>
            <p className="status-text">
              账户不存在、账号停用、授权过期、角色或密级超出许可时，系统将拒绝建立会话。
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
