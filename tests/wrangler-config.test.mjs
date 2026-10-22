import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderWranglerConfig } from '../scripts/prepare-wrangler.mjs'

const template = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
const vars = {
  D1_DATABASE_NAME: 'totpnest-prod',
  D1_DATABASE_ID: '12345678-1234-1234-1234-123456789abc'
}

describe('D1 build-variable configuration', () => {
  it('injects the requested database without changing other Worker bindings', () => {
    const source = JSON.parse(template)
    const generated = JSON.parse(renderWranglerConfig(template, vars))
    expect(generated.d1_databases).toEqual([{
      ...source.d1_databases[0],
      database_name: vars.D1_DATABASE_NAME,
      database_id: vars.D1_DATABASE_ID
    }])
    expect(generated.ratelimits).toEqual(source.ratelimits)
    expect(generated.triggers).toEqual({ crons: ['*/5 * * * *'] })
    expect(generated.assets).toEqual(source.assets)
    expect(generated.main).toBe(source.main)
  })

  it('preserves the exact required runtime secret declarations', () => {
    const expected = ['ADMIN_PASSWORD', 'DATA_ENCRYPTION_KEY']
    const source = JSON.parse(template)
    const generated = JSON.parse(renderWranglerConfig(template, vars))
    expect(source.secrets?.required).toEqual(expected)
    expect(generated.secrets?.required).toEqual(expected)
    expect(generated.vars?.ADMIN_PASSWORD).toBeUndefined()
    expect(generated.vars?.DATA_ENCRYPTION_KEY).toBeUndefined()
  })

  it('rejects absent or invalid build variables', () => {
    expect(() => renderWranglerConfig(template, {})).toThrow('D1_DATABASE_NAME')
    expect(() => renderWranglerConfig(template, { ...vars, D1_DATABASE_ID: '' })).toThrow('D1_DATABASE_ID')
    expect(() => renderWranglerConfig(template, { ...vars, D1_DATABASE_NAME: '../other' })).toThrow()
    expect(() => renderWranglerConfig(template, { ...vars, D1_DATABASE_ID: 'not-a-uuid' })).toThrow()
  })

  it('rejects templates that no longer contain the expected placeholders', () => {
    const modified = template.replace('__D1_DATABASE_NAME__', 'some-other-database')
    expect(() => renderWranglerConfig(modified, vars)).toThrow('Expected a single DB binding')
  })

  it('never embeds raw variable substitutions into JSON', () => {
    const rendered = renderWranglerConfig(template, {
      ...vars,
      D1_DATABASE_NAME: 'totpnest.production_1'
    })
    expect(JSON.parse(rendered).d1_databases[0].database_name).toBe('totpnest.production_1')
  })
})

