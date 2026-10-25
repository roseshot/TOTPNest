import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { copyText, request } from './api'
import { CodePanel } from './CodePanel'
import { ShareCreator } from './ShareCreator'
import { EntryEditor } from './EntryEditor'
import { Brand } from './Brand'
import { ThemeToggle } from './ThemeToggle'
import type { Theme } from './theme'
import { readableError } from './messages'
import { activeEntry, visibleEntries } from './selection'
import { GroupManager } from './GroupManager'
import { ShareLinksPanel } from './ShareLinksPanel'
import { entriesInGroup, type Group, type GroupFilter } from './groups'

type Entry = {
  id: string; issuer: string; account: string; algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: 6 | 8; period: number; groupId: string | null; createdAt: number; updatedAt: number
}
type Share = {
  id: string; entryId: string; issuer: string; account: string; protected: boolean;
  note: string; publicLabel: string; expiresAt: number | null; revokedAt: number | null; createdAt: number;
  viewCount: number; uniqueVisitors: number
}
type ShareHistory = {
  id: string; issuer: string; account: string; publicLabel: string; note: string;
  expiresAt: number | null; createdAt: number; endedAt: number;
  reason: 'revoked' | 'expired' | 'entry_deleted'; viewCount: number; uniqueVisitors: number
}

function formattedDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US')
}

export function Dashboard({ onLogout, theme, onThemeToggle }: {
  onLogout: () => void; theme: Theme; onThemeToggle: () => void
}) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [shares, setShares] = useState<Share[]>([])
  const [shareHistory, setShareHistory] = useState<ShareHistory[]>([])
  const [shareView, setShareView] = useState<'active' | 'history'>('active')
  const [groups, setGroups] = useState<Group[]>([])
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all')
  const [movingGroup, setMovingGroup] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [editor, setEditor] = useState<'add' | 'edit' | null>(null)
  const [sharing, setSharing] = useState(false)
  const [choosingShare, setChoosingShare] = useState(false)
  const [tab, setTab] = useState<'entries' | 'shares'>('entries')
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [manualLink, setManualLink] = useState('')
  const [loading, setLoading] = useState(true)

  const reloadEntries = useCallback(async () => {
    try {
      const result = await request<{ entries: Entry[] }>('/api/admin/entries')
      setEntries(result.entries)
      setSelected((old) => result.entries.some((item) => item.id === old)
        ? old : result.entries[0]?.id || null)
    } catch (cause) { setError(readableError(cause)) }
  }, [])
  const reloadShares = useCallback(async () => {
    try {
      const result = await request<{ shares: Share[] }>('/api/admin/shares')
      setShares(result.shares)
    } catch (cause) { setError(readableError(cause)) }
  }, [])
  const reloadHistory = useCallback(async () => {
    try {
      const result = await request<{ history: ShareHistory[] }>('/api/admin/share-history')
      setShareHistory(result.history)
    } catch (cause) { setError(readableError(cause)) }
  }, [])
  const reloadGroups = useCallback(async () => {
    try {
      const result = await request<{ groups: Group[] }>('/api/admin/groups')
      setGroups(result.groups)
    } catch (cause) { setError(readableError(cause)) }
  }, [])
  const reload = useCallback(async () => {
    setError('')
    await Promise.all([reloadEntries(), reloadShares(), reloadGroups(), reloadHistory()])
    setLoading(false)
  }, [reloadEntries, reloadShares, reloadGroups, reloadHistory])
  useEffect(() => { void reload() }, [reload])
  const groupEntries = useMemo(() => entriesInGroup(entries, groupFilter), [entries, groupFilter])
  const filtered = useMemo(() => visibleEntries(groupEntries, search), [groupEntries, search])
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups])
  // The details must always correspond to an item visible in the filtered list.
  const entry = activeEntry(filtered, selected)
  const selectedGroup = groupFilter === 'all' ? 'All codes' :
    groupFilter === 'ungrouped' ? 'Ungrouped' : groupsById.get(groupFilter) || 'Group'
  const changeGroupFilter = (filter: GroupFilter) => {
    setGroupFilter(filter)
    setEditor(null); setSharing(false); setChoosingShare(false)
  }
  const moveEntry = async (item: Entry, groupId: string | null) => {
    if (movingGroup || groupId === item.groupId) return
    setMovingGroup(true); setError(''); setNotice('')
    try {
      await request('/api/admin/entries/' + item.id + '/group', {
        method: 'PUT', body: { groupId }
      })
      // Keep the moved code visible even when it leaves the current group filter.
      setGroupFilter('all')
      setSelected(item.id)
      await reloadEntries()
      const groupName = groupId ? groupsById.get(groupId) || 'Group' : 'Ungrouped'
      setNotice('Moved to ' + groupName)
    } catch (cause) { setError(readableError(cause)) }
    finally { setMovingGroup(false) }
  }
  const changeSearch = (value: string) => {
    setSearch(value)
    setEditor(null)
    setSharing(false)
  }
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'entries' : event.key === 'End' ? 'shares'
      : tab === 'entries' ? 'shares' : 'entries'
    setTab(next)
    setChoosingShare(false)
    document.getElementById('tab-' + next)?.focus()
  }
  const removeEntry = async (item: Entry) => {
    if (!window.confirm(`Delete "${item.issuer || item.account || 'Unnamed code'}" and all its share links? This cannot be undone.`)) return
    try {
      await request('/api/admin/entries/' + item.id, { method: 'DELETE' })
      setEditor(null); setSharing(false)
      await Promise.all([reloadEntries(), reloadShares(), reloadHistory()])
    } catch (cause) { setError(readableError(cause)) }
  }
  const revoke = async (id: string) => {
    if (!window.confirm("Stop sharing this code? People won't be able to get new codes from this link. A code already copied may still work until it changes.")) return
    try {
      await request('/api/admin/shares/' + id, { method: 'DELETE' })
      await Promise.all([reloadShares(), reloadHistory()])
    } catch (cause) { setError(readableError(cause)) }
  }
  const copyLink = async (id: string) => {
    setError('')
    setManualLink('')
    try {
      const link = await request<{ url: string }>('/api/admin/shares/' + id + '/link')
      if (!await copyText(link.url)) {
        setNotice('')
        setManualLink(link.url)
        return
      }
      setNotice('Link copied')
      window.setTimeout(() => setNotice(''), 3000)
    } catch (cause) { setError(readableError(cause)) }
  }
  const logout = async () => {
    await request('/api/admin/logout', { method: 'POST' }).catch(() => {})
    onLogout()
  }

  const activeShares = useMemo(() => shares.filter((share) =>
    share.revokedAt === null && (share.expiresAt === null || share.expiresAt > Date.now())), [shares])
  const expiringShares = useMemo(() => activeShares.filter((share) =>
    share.expiresAt !== null && share.expiresAt - Date.now() <= 3 * 24 * 60 * 60 * 1000), [activeShares])
  const protectedShareCount = useMemo(() =>
    activeShares.reduce((count, share) => count + Number(share.protected), 0), [activeShares])

  const startNew = () => {
    setSearch('')
    if (tab === 'shares') setGroupFilter('all')
    setTab('entries')
    setShareView('active')
    setSharing(false)
    setEditor(null)
    // Sharing is account-specific. Never silently choose a previously selected code.
    if (tab === 'shares' && entries.length > 0) {
      setChoosingShare(true)
    } else {
      setChoosingShare(false)
      setEditor('add')
    }
  }

  return <div className="dashboard">
    <aside className="sidebar" aria-label="Administrator navigation">
      <Brand />
      <div className="sidebar-group">
        <p className="sidebar-label">YOUR CODES</p>
        <nav className="sidebar-nav" aria-label="Manage">
          <button type="button" className={'sidebar-link ' + (tab === 'entries' ? 'active' : '')}
            aria-current={tab === 'entries' ? 'page' : undefined}
            onClick={() => { setTab('entries'); setSharing(false); setEditor(null); setChoosingShare(false) }}>
            <span className="sidebar-icon" aria-hidden="true">▦</span> Verification codes
            <span className="sidebar-count">{entries.length}</span>
          </button>
          <button type="button" className={'sidebar-link ' + (tab === 'shares' ? 'active' : '')}
            aria-current={tab === 'shares' ? 'page' : undefined}
            onClick={() => { setTab('shares'); setShareView('active'); setChoosingShare(false) }}>
            <span className="sidebar-icon" aria-hidden="true">↗</span> Share links
            <span className="sidebar-count">{activeShares.length}</span>
          </button>
        </nav>
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-safe-icon" aria-hidden="true">✦</div>
        <strong>Stay in control of shared codes.</strong>
        <p>You can stop sharing a link whenever you need to.</p>
      </div>
      <p className="sidebar-version">TOTPNest · Your saved codes</p>
    </aside>
    <div className="dashboard-content">
      <header className="topbar">
        <div className="breadcrumb"><span>YOUR CODES</span><strong> / {tab === 'entries' ? 'Verification codes' : 'Share links'}</strong></div>
        <div className="topbar-actions">
          <button type="button" className="quiet refresh-button" onClick={() => void reload()}>↻ <span>Refresh</span></button>
          <ThemeToggle theme={theme} onToggle={onThemeToggle} />
          <button type="button" className="quiet sign-out" onClick={() => void logout()}>Sign out</button>
        </div>
      </header>
      <main className="workspace">
        <section className="hero-banner">
          <div className="hero-copy">
            <span className="eyebrow">YOUR CODES AT A GLANCE</span>
            <h1>Find your sign-in code, fast.</h1>
            <p>Choose an account to see its current code, or share it with someone you trust.</p>
          </div>
          <img src="/totpnest-logo.svg" alt="" className="hero-logo" aria-hidden="true" />
        </section>
        <section className="metric-grid" aria-label="Workspace overview">
          <div className="metric-card"><span className="metric-icon" aria-hidden="true">▦</span>
            <span className="metric-label">Saved codes</span><strong>{entries.length}</strong><small>Ready when needed</small></div>
          <div className="metric-card"><span className="metric-icon" aria-hidden="true">↗</span>
            <span className="metric-label">Active links</span><strong>{activeShares.length}</strong><small>Links people can open</small></div>
          <div className="metric-card"><span className="metric-icon" aria-hidden="true">⌑</span>
            <span className="metric-label">Links with passwords</span>
            <strong>{protectedShareCount}</strong><small>Password needed to open</small></div>
          <div className="metric-card"><span className="metric-icon" aria-hidden="true">◷</span>
            <span className="metric-label">Expiring soon</span><strong>{expiringShares.length}</strong><small>Within three days</small></div>
        </section>
        <div className="section-head heading">
          <div><span className="eyebrow">FIND A CODE</span>
            <h2>{tab === 'entries' ? 'Verification codes' : 'Share links'}</h2>
            <p className="muted">{tab === 'entries'
              ? 'Select an account to view its current code, or add a new one.'
              : 'See which links you shared and stop sharing them when you choose.'}</p>
          </div>
          <button type="button" className="primary add-button" onClick={startNew}>
            <span aria-hidden="true">＋</span> {tab === 'entries' ? 'Add a code' : 'Create share link'}
          </button>
        </div>
        <div className="tabs" role="tablist" aria-label="Dashboard sections">
          <button id="tab-entries" role="tab" aria-controls="panel-entries" aria-selected={tab === 'entries'}
            tabIndex={tab === 'entries' ? 0 : -1} onKeyDown={onTabKeyDown}
            className={tab === 'entries' ? 'active' : ''}
            onClick={() => { setTab('entries'); setChoosingShare(false) }}>
            Saved codes <span>{entries.length}</span>
          </button>
          <button id="tab-shares" role="tab" aria-controls="panel-shares" aria-selected={tab === 'shares'}
            tabIndex={tab === 'shares' ? 0 : -1} onKeyDown={onTabKeyDown}
            className={tab === 'shares' ? 'active' : ''}
            onClick={() => { setTab('shares'); setShareView('active'); setChoosingShare(false) }}>
            Share links <span>{activeShares.length}</span>
          </button>
        </div>
        {error && <p className="message error workspace-message" role="alert">{error}</p>}
        {notice && <p className="message success-message workspace-message" role="status">{notice}</p>}
        {manualLink && <div className="card manual-link" role="status">
          <p>Couldn't copy automatically. Select the link below and copy it yourself.</p>
          <textarea readOnly autoFocus value={manualLink} rows={2} aria-label="Share link for manual copying"
            onFocus={(event) => event.currentTarget.select()} />
          <button type="button" onClick={() => setManualLink('')}>Dismiss</button>
        </div>}
        {tab === 'entries' && <GroupManager groups={groups} entries={entries}
          filter={groupFilter} onSelect={changeGroupFilter} onChanged={reload} />}
        {tab === 'entries' && <div className="workspace-grid" role="tabpanel" id="panel-entries"
          aria-labelledby="tab-entries" tabIndex={0}>
          <aside className="card entry-list" aria-label="Saved code list">
            <div className="list-heading">
              <strong>{selectedGroup}</strong>
              <span>{groupEntries.length} codes</span>
            </div>
            <div className="search-field">
              <input className="search" type="search" aria-label="Search saved codes"
                placeholder="Search services or accounts..." value={search}
                onChange={(e) => changeSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') changeSearch('') }} />
              {search && <button type="button" className="search-clear" onClick={() => changeSearch('')}
                aria-label="Clear search">Clear</button>}
            </div>
            {!loading && entries.length > 0 && <p className="muted small search-count" role="status">
              {filtered.length} of {groupEntries.length} codes shown
            </p>}
            <div className="entry-scroll">
              {filtered.length ? filtered.map((item) => <button key={item.id}
                className={'entry-row ' + (item.id === entry?.id ? 'selected' : '')}
                aria-pressed={item.id === entry?.id}
                onClick={() => {
                  setSelected(item.id)
                  setEditor(null)
                  setSharing(choosingShare)
                  setChoosingShare(false)
                }}>
                <span className="entry-avatar" aria-hidden="true">
                  {(item.issuer || item.account || '?').slice(0, 1).toUpperCase()}
                </span>
                <span className="entry-label"><strong>{item.issuer || 'Unnamed'}</strong>
                  <small>{item.account || 'No account specified'}</small>
                  {groupFilter === 'all' && item.groupId && <small className="entry-group-tag">
                    {groupsById.get(item.groupId)}
                  </small>}
                </span>
                <span className="entry-arrow" aria-hidden="true">›</span>
              </button>) : <p className="muted empty">
                {loading ? 'Loading saved codes...' : entries.length ? 'No codes match your search.' : 'No codes saved yet.'}
              </p>}
            </div>
          </aside>
          <section className="detail-column" aria-label="Check the details">
            {editor ? <EntryEditor key={editor + (editor === 'edit' ? entry?.id : '')}
              entry={editor === 'edit' ? entry : undefined} groups={groups}
              suggestedGroupId={groups.some((group) => group.id === groupFilter) ? groupFilter : null}
              onCancel={() => setEditor(null)}
              onSaved={(savedId) => {
                setEditor(null)
                setChoosingShare(false)
                setSearch('')
                setGroupFilter('all')
                if (savedId) setSelected(savedId)
                setNotice('Code saved')
                void reloadEntries()
              }}/>
            : sharing && entry ? <ShareCreator key={entry.id} entry={entry}
              onCreated={() => void reloadShares()} onCancel={() => setSharing(false)} />
            : choosingShare ? <div className="card empty-state share-choice">
              <span className="empty-symbol" aria-hidden="true">↗</span>
              <h2>Which code would you like to share?</h2>
              <p className="muted">Choose an account from your list to create a link for its code.</p>
              {entries.length === 0
                ? <button type="button" className="primary" onClick={() => {
                    setChoosingShare(false)
                    setEditor('add')
                  }}>Add a code first</button>
                : <button type="button" onClick={() => setChoosingShare(false)}>Cancel</button>}
            </div>
          : entry ? <>
              <div className="card account-card">
                <div className="account-ident">
                  <span className="account-ident-icon" aria-hidden="true">
                    {(entry.issuer || entry.account || '?').slice(0, 1).toUpperCase()}
                  </span>
                  <div><span className="eyebrow">CURRENT ACCOUNT</span>
                    <h2>{entry.issuer || 'Unnamed'}</h2><p className="muted">{entry.account}</p></div>
                </div>
                <div className="account-actions">
                  <button type="button" onClick={() => setEditor('edit')}>Edit</button>
                  <button type="button" onClick={() => setSharing(true)} className="primary">Share code</button>
                  <button type="button" className="danger-button" onClick={() => void removeEntry(entry)}>Delete</button>
                </div>
              </div>
              <div className="account-group-move">
                <label htmlFor="move-entry-group">Group</label>
                <select id="move-entry-group" value={entry.groupId || ''}
                  disabled={movingGroup} onChange={(event) => {
                    void moveEntry(entry, event.target.value || null)
                  }}>
                  <option value="">Ungrouped</option>
                  {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
                <span className="muted small">{movingGroup ? 'Moving code...' : 'Move this code to another group.'}</span>
              </div>
              <CodePanel key={entry.id} endpoint={'/api/admin/entries/' + entry.id}/>
              <p className="muted small code-meta">{entry.digits}-digit code · Changes every {entry.period} seconds</p>
            </> : loading ? <div className="card empty" role="status">Loading your codes...</div>
            : entries.length ? <div className="card empty-state">
              <span className="empty-symbol" aria-hidden="true">⌕</span>
              <h2>{search ? 'No matching codes' : 'No codes in this group'}</h2>
              <p className="muted">{search ? 'Try another search or clear the search box.'
                : 'You can move a saved code here or add a new one.'}</p>
              <button type="button" onClick={() => search ? changeSearch('') : changeGroupFilter('all')}>
                {search ? 'Clear search' : 'Show all codes'}
              </button>
              {!search && <button type="button" className="primary" onClick={() => setEditor('add')}>
                Add a code
              </button>}
            </div> : <div className="card empty-state">
              <span className="empty-symbol" aria-hidden="true">＋</span>
              <h2>Add your first code</h2>
              <p className="muted">Import a setup link, upload a QR image, or enter a setup key.</p>
              <button type="button" className="primary" onClick={() => setEditor('add')}>Add a code</button>
            </div>}
          </section>
        </div>}
        {tab === 'shares' && <ShareLinksPanel
          shares={shares} history={shareHistory} view={shareView}
          onViewChange={setShareView} loading={loading} entryCount={entries.length}
          onCreateShare={startNew} onCopyLink={copyLink} onRevoke={revoke}
        />}
      </main>
    </div>
  </div>
}
