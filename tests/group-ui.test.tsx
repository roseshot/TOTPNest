import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { GroupManager } from '../src/client/GroupManager'

describe('group management UI', () => {
  it('shows a filter for all groups and ungrouped codes with accurate counts', () => {
    const html = renderToStaticMarkup(createElement(GroupManager, {
      groups: [{ id: 'work', name: 'Work' }, { id: 'family', name: 'Family' }],
      entries: [{ groupId: 'work' }, { groupId: 'work' }, { groupId: null }],
      filter: 'work',
      onSelect: () => {},
      onChanged: async () => {}
    }))
    expect(html).toContain('Manage groups')
    expect(html).toContain('All codes')
    expect(html).toContain('Ungrouped')
    expect(html).toContain('Work')
    expect(html).toContain('Family')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('class="group-filter selected"')
    expect(html).toContain('aria-pressed="false"')
  })
})
