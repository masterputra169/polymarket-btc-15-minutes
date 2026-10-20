import { useState } from 'react';
import type { FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

interface LoginPageProps {
  onLogin: (password: string) => Promise<void>;
  authError?: string | null;
}

const CANDLES = [
  { h: 34, up: true }, { h: 58, up: false }, { h: 42, up: true }, { h: 72, up: true },
  { h: 48, up: false }, { h: 64, up: true }, { h: 88, up: true }, { h: 54, up: false },
  { h: 76, up: true }, { h: 44, up: false }, { h: 68, up: true }, { h: 92, up: true },
];

export function AuthSplash() {
  return (
    <div className="login-shell login-shell--splash">
      <div className="login-grid" />
      <motion.div className="login-orb login-orb--one" animate={{ scale: [1, 1.18, 1], opacity: [0.35, 0.55, 0.35] }} transition={{ duration: 8, repeat: Infinity }} />
      <motion.div className="login-orb login-orb--two" animate={{ scale: [1.1, 0.9, 1.1], opacity: [0.25, 0.45, 0.25] }} transition={{ duration: 11, repeat: Infinity }} />
      <div className="auth-splash">
        <motion.div className="auth-splash__mark" animate={{ rotate: 360 }} transition={{ duration: 16, repeat: Infinity, ease: 'linear' }}>₿</motion.div>
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <strong>POLY//15</strong>
          <span>VERIFYING OPERATOR SESSION</span>
        </motion.div>
        <motion.div className="auth-splash__bar" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 1.2, repeat: Infinity, repeatType: 'reverse' }} />
      </div>
    </div>
  );
}

export default function LoginPage({ onLogin, authError = null }: LoginPageProps) {
  const reduce = useReducedMotion();
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password) { setError('Enter the operator password.'); return; }
    setBusy(true); setError(null);
    try { await onLogin(password); } catch (err) { setError(err instanceof Error ? err.message : 'Login failed.'); setBusy(false); }
  }

  return (
    <div className="login-shell">
      <div className="login-grid" />
      <div className="login-scan" />
      <motion.div className="login-orb login-orb--one" animate={reduce ? undefined : { x: [0, 42, -18, 0], y: [0, -28, 22, 0], scale: [1, 1.12, 0.96, 1] }} transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut' }} />
      <motion.div className="login-orb login-orb--two" animate={reduce ? undefined : { x: [0, -34, 24, 0], y: [0, 26, -18, 0], scale: [1, 0.92, 1.08, 1] }} transition={{ duration: 27, repeat: Infinity, ease: 'easeInOut' }} />
      <motion.div className="login-orb login-orb--three" animate={reduce ? undefined : { x: [0, 20, -26, 0], y: [0, 18, -24, 0] }} transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }} />
      <div className="login-candles" aria-hidden>
        {CANDLES.map((c, i) => (
          <motion.span key={i} className={c.up ? 'is-up' : 'is-down'} style={{ height: c.h }} animate={reduce ? undefined : { scaleY: [1, 0.72, 1.08, 1], opacity: [0.22, 0.62, 0.34, 0.22] }} transition={{ duration: 4.5 + (i % 4) * 0.8, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }} />
        ))}
      </div>
      <motion.main className="login-card" initial={{ opacity: 0, y: 18, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}>
        <div className="login-card__top">
          <motion.div className="login-mark" initial={{ rotate: -8 }} animate={{ rotate: 0 }} transition={{ type: 'spring', stiffness: 180, damping: 14 }}>₿</motion.div>
          <div className="login-brand"><strong>POLY<span>//</span>15</strong><small>PRIVATE OPERATOR CONSOLE</small></div>
          <span className="login-secure"><i /> SECURE</span>
        </div>
        <div className="login-heading">
          <span className="login-kicker">BTC 15M · CONTROL PLANE</span>
          <h1>Operator access</h1>
          <p>Sign in to open the live market workspace. Control actions stay locked until this session is verified.</p>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label className="login-label" htmlFor="operator-password">Password</label>
          <div className="login-input-wrap">
            <span className="login-input-icon">⌁</span>
            <input id="operator-password" type={show ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter operator password" autoComplete="current-password" autoFocus disabled={busy} />
            <button type="button" className="login-eye" onClick={() => setShow(v => !v)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? 'HIDE' : 'SHOW'}</button>
          </div>
          <AnimatePresence mode="wait">
            {(error || authError) && (
              <motion.div key={error || authError} className="login-error" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}><span>⚠</span>{error || authError}</motion.div>
            )}
          </AnimatePresence>
          <motion.button type="submit" className="login-submit" disabled={busy} whileHover={reduce ? undefined : { y: -1 }} whileTap={reduce ? undefined : { scale: 0.99 }}><span>{busy ? 'VERIFYING…' : 'ENTER CONSOLE'}</span><span className="login-submit__arrow">→</span></motion.button>
        </form>
        <div className="login-card__foot">
          <span><i className="dot-green" /> PAPER TRADING ENVIRONMENT</span>
          <span>session · 12h</span>
        </div>
      </motion.main>
      <div className="login-bottom">
        <span>NOT FINANCIAL ADVICE</span>
        <span>BTC/USD · CHAINLINK TWAP · POLYMARKET</span>
        <span>BUILD 2026.10</span>
      </div>
    </div>
  );
}
