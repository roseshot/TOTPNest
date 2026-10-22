/** Pair the official shield-and-nest icon with accessible, theme-aware brand text. */
export function Brand({ className = '' }: { className?: string }) {
  return <div className={('brand ' + className).trim()}>
    <img className="brand-mark" src="/totpnest-logo.svg" width={46} height={46}
      alt="" aria-hidden="true" />
    <span className="brand-name">TOTP<strong>Nest</strong></span>
  </div>
}
