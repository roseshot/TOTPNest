/** Reusable wordmark. The same local asset is used on private and public screens. */
export function Brand({ className = '' }: { className?: string }) {
  return <div className={('brand ' + className).trim()}>
    <img className="brand-mark" src="/totpnest-logo.svg" width={46} height={46}
      alt="" aria-hidden="true" />
    <span className="brand-name">TOTP<strong>Nest</strong></span>
  </div>
}
