import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseWranglerTemplate, renderWranglerConfig } from '../scripts/prepare-wrangler.mjs'

const template = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
const vars = {
  D1_DATABASE_NAME: 'totpnest-prod',
  D1_DATABASE_ID: '12345678-1234-1234-1234-123456789abc'
}

describe('D1 build-variable configuration', () => {
  it('injects the requested database without changing other Worker bindings', () => {
    const source = parseWranglerTemplate(template)
    const generated = JSON.parse(renderWranglerConfig(template, vars))
    expect(generated.d1_databases).toEqual([{
      ...source.d1_databases[0],
      database_name: vars.D1_DATABASE_NAME,
      database_id: vars.D1_DATABASE_ID
    }])
    expect(generated.ratelimits).toEqual(source.ratelimits)
    expect(generated.triggers).toEqual({ crons: ['0 0 * * *'] })
    expect(generated.assets).toEqual(source.assets)
    expect(generated.main).toBe(source.main)
  })

  it('preserves the exact required runtime secret declarations', () => {
    const expected = ['ADMIN_PASSWORD', 'DATA_ENCRYPTION_KEY']
    const source = parseWranglerTemplate(template)
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
  it('keeps access restrictions and observability settings on generated deployments', () => {
    const generated = JSON.parse(renderWranglerConfig(template, vars))
    expect(generated.workers_dev).toBe(false)
    expect(generated.preview_urls).toBe(false)
    expect(generated.observability).toEqual({
      enabled: true,
      redact_query_string: true,
      head_sampling_rate: 1,
      issues: { enabled: true }
    })
  })

  it('supports comments and trailing commas without copying them into generated JSON', () => {
    const commented = template.replace(
      '"preview_urls": false,',
      '"preview_urls": false, /* keep preview URLs off */'
    )
    const trailing = commented.replace(
      /("issues":\s*\{\s*"enabled": true)(\s*\})/,
      '$1,$2'
    )
    expect(trailing).not.toBe(commented)
    const rendered = renderWranglerConfig(trailing, vars)
    expect(JSON.parse(rendered).preview_urls).toBe(false)
    expect(rendered).not.toContain('keep preview URLs off')
  })

  it('rejects malformed JSONC and non-object root values', () => {
    expect(() => renderWranglerConfig('{"name": "totpnest", invalid}', vars))
      .toThrow('Invalid wrangler.jsonc')
    expect(() => renderWranglerConfig('[]', vars))
      .toThrow('root must be an object')
  })

})
