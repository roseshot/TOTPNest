type Share = {
  id: string; issuer: string; account: string; protected: boolean; note: string;
  publicLabel: string; expiresAt: number | null; revokedAt: number | null;
  createdAt: number; viewCount: number; uniqueVisitors: number
}
type ShareHistory = {
  id: string; issuer: string; account: string; publicLabel: string; note: string;
  expiresAt: number | null; createdAt: number; endedAt: number;
  reason: 'revoked' | 'expired' | 'entry_deleted'; viewCount: number; uniqueVisitors: number
}
type Props = {
  shares: Share[]; history: ShareHistory[]; view: 'active' | 'history';
  onViewChange: (view: 'active' | 'history') => void; loading: boolean; entryCount: number;
  onCreateShare: () => void; onCopyLink: (id: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>
}
function formattedDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US')
}
export function ShareLinksPanel({
  shares, history, view, onViewChange, loading, entryCount,
  onCreateShare, onCopyLink, onRevoke
}: Props) {
  return (
      <section className="share-manager-panel" role="tabpanel"
            id="panel-shares" aria-labelledby="tab-shares" tabIndex={0}>
            <div className="share-view-switch" role="group" aria-label="Share link views">
              <button type="button" aria-pressed={view === 'active'}
                className={view === 'active' ? 'selected' : ''}
                onClick={() => setShareView('active')}>Active links <span>{shares.length}</span></button>
              <button type="button" aria-pressed={view === 'history'}
                className={view === 'history' ? 'selected' : ''}
                onClick={() => setShareView('history')}>History <span>{history.length}</span></button>
            </div>
            {view === 'active' ? <div className="card shares-list">
              {shares.length === 0 && <div className="empty-state">
                <span className="empty-symbol" aria-hidden="true">↗</span>
                <h2>{loading ? 'Loading share links...' : "You haven't shared any codes yet"}</h2>
                {!loading && <>
                  <p className="muted">Choose an account first, then decide how long to share its code.</p>
                  <button type="button" className="primary" onClick={onCreateShare}>
                    {entryCount ? 'Create a share link' : 'Add a code'}
                  </button>
                </>}
              </div>}
              {shares.map((share) => {
                const revoked = share.revokedAt !== null
                const expired = share.expiresAt !== null && share.expiresAt < Date.now()
                return <div className="share-row" key={share.id}>
                  <div className="share-info">
                    <span className="share-icon" aria-hidden="true">↗</span>
                    <div><strong>{share.issuer || 'Unnamed'}</strong><span className="muted small share-account">{share.account}</span>
                      {share.publicLabel && <span className="muted small">Recipient label: {share.publicLabel}</span>}
                      <span className="muted small">{share.protected ? 'Password required' : 'Anyone with the link'}
                        {share.note ? ' · ' + share.note : ''} · {share.expiresAt !== null
                          ? 'Expires ' + formattedDate(share.expiresAt) : 'Does not expire'}</span>
                      <span className="share-views" title="Views are lifetime successful page views. UV estimates unique browsers in the last 90 days.">
                        <span>Views: {share.viewCount}</span><span aria-hidden="true">·</span>
                        <span><abbr title="Unique browsers in the last 90 days">UV (90d)</abbr>: {share.uniqueVisitors}</span>
                      </span></div>
                  </div>
                  <div className="share-actions">
                    <span className={'status ' + (revoked || expired ? 'danger' : 'success')}>
                      {revoked ? 'Stopped' : expired ? 'Expired' : 'Active'}</span>
                    {!revoked && !expired && <button type="button" onClick={() => void onCopyLink(share.id)}>Copy link</button>}
                    {!revoked && <button type="button" className="danger-button" onClick={() => void onRevoke(share.id)}>Stop sharing</button>}
                  </div>
                </div>
              })}
            </div> : <div className="card shares-list">
              {history.length === 0 ? <div className="empty-state">
                <span className="empty-symbol" aria-hidden="true">◷</span>
                <h2>No share history yet</h2>
                <p className="muted">Revoked, expired, and deleted-account links will appear here.</p>
              </div> : history.map((item) => <div className="share-row" key={item.id}>
                <div className="share-info">
                  <span className="share-icon" aria-hidden="true">↗</span>
                  <div><strong>{item.issuer || 'Unnamed'}</strong>
                    <span className="muted small share-account">{item.account}</span>
                    {item.publicLabel && <span className="muted small">Recipient label: {item.publicLabel}</span>}
                    <span className="muted small">{item.reason === 'revoked' ? 'Stopped sharing'
                      : item.reason === 'expired' ? 'Expired' : 'Account deleted'} · Ended {formattedDate(item.endedAt)}</span>
                    <span className="share-views">
                      <span>Views: {item.viewCount}</span><span aria-hidden="true">·</span>
                      <span><abbr title="Unique browsers during the final 90 days">UV (90d)</abbr>: {item.uniqueVisitors}</span>
                    </span></div>
                </div>
                <div className="share-actions"><span className="status danger">
                  {item.reason === 'revoked' ? 'Stopped' : item.reason === 'expired' ? 'Expired' : 'Deleted'}
                </span></div>
              </div>)}
            </div>}
          </section>
  )
}
