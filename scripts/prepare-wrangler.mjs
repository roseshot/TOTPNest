import { readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, printParseErrorCode } from 'jsonc-parser'

const templatePath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))
const generatedPath = fileURLToPath(new URL('../wrangler.generated.jsonc', import.meta.url))

/** Parse JSONC strictly so malformed deployment configs cannot be partially applied. */
export function parseWranglerTemplate(templateText) {
  const errors = []
  const config = parse(templateText, errors, { allowTrailingComma: true })

  if (errors.length > 0) {
    const first = errors[0]
    throw new Error(
      `Invalid wrangler.jsonc: ${printParseErrorCode(first.error)} at offset ${first.offset}`
    )
  }

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid wrangler.jsonc: root must be an object')
  }

  return config
}

/** Render a deploy-only Wrangler configuration from Cloudflare build variables. */
export function renderWranglerConfig(templateText, variables) {
  const name = variables.D1_DATABASE_NAME?.trim()
  const id = variables.D1_DATABASE_ID?.trim()

  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new Error('D1_DATABASE_NAME must be a valid D1 database name (1-128 characters).')
  }
  if (!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('D1_DATABASE_ID must be a valid D1 database UUID.')
  }

  const config = parseWranglerTemplate(templateText)
  const binding = config.d1_databases?.find((item) => item.binding === 'DB')
  if (!binding || binding.database_name !== '__D1_DATABASE_NAME__' ||
      binding.database_id !== '__D1_DATABASE_ID__' || config.d1_databases.length !== 1) {
    throw new Error('Expected a single DB binding with D1 build-variable placeholders.')
  }

  binding.database_name = name
  binding.database_id = id
  return JSON.stringify(config, null, 2) + '\n'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Never leave an earlier generated deployment config after a failed validation.
  await rm(generatedPath, { force: true })
  const config = renderWranglerConfig(await readFile(templatePath, 'utf8'), process.env)
  await writeFile(generatedPath, config, { mode: 0o600 })
  console.info('Generated Wrangler deployment configuration from build variables.')
}

