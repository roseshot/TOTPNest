import { useState, type FormEvent } from 'react'
import { request } from './api'
import { readableError } from './messages'
import { entriesInGroup, type Group, type GroupFilter } from './groups'

type Props = {
  groups: Group[]
  entries: { groupId: string | null }[]
  filter: GroupFilter
  onSelect: (filter: GroupFilter) => void
  onChanged: () => Promise<void>
}

export function GroupManager({ groups, entries, filter, onSelect, onChanged }: Props) {
  const [managing, setManaging] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!newName.trim() || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await request<{ id: string }>('/api/admin/groups', {
        method: 'POST', body: { name: newName.trim() }
      })
      setNewName('')
      onSelect(result.id)
      await onChanged()
      setNotice('Group created. Select an account to move a code into it.')
    } catch (cause) { setError(readableError(cause)) }
    finally { setBusy(false) }
  }

  const rename = async (event: FormEvent<HTMLFormElement>, id: string) => {
    event.preventDefault()
    if (!editName.trim() || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request('/api/admin/groups/' + id, { method: 'PUT', body: { name: editName.trim() } })
      setEditingId(null)
      await onChanged()
      setNotice('Group renamed.')
    } catch (cause) { setError(readableError(cause)) }
    finally { setBusy(false) }
  }

  const remove = async (group: Group) => {
    if (busy) return
    const count = entriesInGroup(entries, group.id).length
    if (!window.confirm(
      `Delete "${group.name}"? Its ${count} saved ${count === 1 ? 'code' : 'codes'} will move to Ungrouped. Share links will keep working.`
    )) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request('/api/admin/groups/' + group.id, { method: 'DELETE' })
      if (filter === group.id) onSelect('ungrouped')
      if (editingId === group.id) setEditingId(null)
      await onChanged()
      setNotice('Group deleted. All codes in it are now ungrouped.')
    } catch (cause) { setError(readableError(cause)) }
    finally { setBusy(false) }
  }

  return <section className="group-section" aria-label="Code groups">
    <div className="group-section-head">
      <div><strong>Groups</strong><p className="muted small">Choose a group to find its codes.</p></div>
      <button type="button" className="quiet" aria-expanded={managing}
        aria-controls="group-management"
        onClick={() => { setManaging((open) => !open); setError(''); setNotice('') }}>
        {managing ? 'Done' : 'Manage groups'}
      </button>
    </div>
    <div className="group-filters" role="group" aria-label="Filter saved codes">
      <button type="button" aria-pressed={filter === 'all'} className={'group-filter ' + (filter === 'all' ? 'selected' : '')}
        onClick={() => onSelect('all')}>All codes <span>{entries.length}</span></button>
      {groups.map((group) => <button type="button" key={group.id}
        aria-pressed={filter === group.id} className={'group-filter ' + (filter === group.id ? 'selected' : '')}
        onClick={() => onSelect(group.id)}>{group.name}
        <span>{entriesInGroup(entries, group.id).length}</span>
      </button>)}
      <button type="button" aria-pressed={filter === 'ungrouped'}
        className={'group-filter ' + (filter === 'ungrouped' ? 'selected' : '')}
        onClick={() => onSelect('ungrouped')}>Ungrouped
        <span>{entriesInGroup(entries, 'ungrouped').length}</span>
      </button>
    </div>
    {managing && <div className="group-management card" id="group-management">
      <div className="group-management-intro">
        <h3>Manage groups</h3>
        <p className="muted small">Organize saved codes without changing how they work.</p>
      </div>
      <form onSubmit={(event) => void create(event)} className="group-create-form">
        <label htmlFor="new-group-name">New group</label>
        <div className="field-row">
          <input id="new-group-name" value={newName} maxLength={50}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="e.g. Work, Personal" disabled={busy} />
          <button className="primary" type="submit" disabled={busy || !newName.trim()}>
            Add group
          </button>
        </div>
      </form>
      {groups.length === 0 && <p className="muted small">No groups yet. Add one above to get started.</p>}
      <div className="group-management-list">
        {groups.map((group) => <div className="group-management-row" key={group.id}>
          {editingId === group.id ? <form className="group-rename-form"
            onSubmit={(event) => void rename(event, group.id)}>
            <label htmlFor={'rename-group-' + group.id}>Rename {group.name}</label>
            <div className="field-row">
              <input id={'rename-group-' + group.id} autoFocus maxLength={50} value={editName}
                onChange={(event) => setEditName(event.target.value)} disabled={busy} />
              <button type="submit" disabled={busy || !editName.trim()}>Save</button>
              <button type="button" disabled={busy} onClick={() => setEditingId(null)}>Cancel</button>
            </div>
          </form> : <>
            <div className="group-management-name"><strong>{group.name}</strong>
              <span className="muted small">{entriesInGroup(entries, group.id).length} codes</span>
            </div>
            <div className="group-management-actions">
              <button type="button" disabled={busy} onClick={() => {
                setEditingId(group.id); setEditName(group.name); setError(''); setNotice('')
              }}>Rename</button>
              <button type="button" className="danger-button" disabled={busy}
                onClick={() => void remove(group)}>Delete</button>
            </div>
          </>}
        </div>)}
      </div>
      {error && <p className="message error" role="alert">{error}</p>}
      {notice && <p className="message success-message" role="status">{notice}</p>}
    </div>}
  </section>
}
